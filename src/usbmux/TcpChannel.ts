import { Logger, NULL_LOGGER } from '../logger';
import {
  describeTcpFlags,
  encodeTcpSegment,
  MUX_HEADER_V2_SIZE,
  MUX_MAX_OUT_PACKET,
  TCP_FLAG_ACK,
  TCP_FLAG_FIN,
  TCP_FLAG_RST,
  TCP_FLAG_SYN,
  TCP_HEADER_SIZE,
  TcpHeader,
} from './protocol';

export type ChannelState = 'new' | 'connecting' | 'connected' | 'closed' | 'refused';

// What we advertise to the device. usbmuxd shifts windows by 8 bits on the wire.
export const DEFAULT_RECEIVE_WINDOW = 131072;
export const DEFAULT_MAX_SEGMENT = MUX_MAX_OUT_PACKET - MUX_HEADER_V2_SIZE - TCP_HEADER_SIZE;
const WINDOW_SHIFT = 8;

export interface TcpChannelOptions {
  receiveWindow?: number;
  maxSegmentSize?: number;
  logger?: Logger;
}

/**
 * One usbmux "TCP" connection to a port on the device.
 *
 * usbmux tunnels a deliberately minimal TCP over the reliable USB link: there are no retransmissions or
 * checksums, but the device does expect the SYN / SYN-ACK / ACK handshake, prompt ACKs of everything it sends,
 * and that we stay within the window it advertises. This mirrors the state machine in usbmuxd's `device.c`.
 */
export default class TcpChannel {
  readonly sourcePort: number;
  readonly destinationPort: number;

  onData: ((data: Uint8Array) => void) | null = null;
  onStateChange: ((state: ChannelState, previous: ChannelState) => void) | null = null;

  private currentState: ChannelState = 'new';
  private txSeq = 0;
  private txAck = 0;
  private rxAck = 0;
  private peerWindow = 0;
  private readonly receiveWindow: number;
  private readonly maxSegmentSize: number;
  private readonly logger: Logger;
  private readonly sendSegment: (segment: Uint8Array) => void;
  private readonly release: () => void;
  private pending: Uint8Array[] = [];
  private connectWaiters: { resolve: () => void; reject: (error: Error) => void }[] = [];

  constructor(
    sendSegment: (segment: Uint8Array) => void,
    sourcePort: number,
    destinationPort: number,
    options: TcpChannelOptions = {},
    release: () => void = () => undefined,
  ) {
    this.sendSegment = sendSegment;
    this.release = release;
    this.sourcePort = sourcePort;
    this.destinationPort = destinationPort;
    this.receiveWindow = options.receiveWindow ?? DEFAULT_RECEIVE_WINDOW;
    this.maxSegmentSize = options.maxSegmentSize ?? DEFAULT_MAX_SEGMENT;
    this.logger = options.logger ?? NULL_LOGGER;
  }

  get state(): ChannelState {
    return this.currentState;
  }

  // Bytes accepted by write() that the device's window has not yet allowed us to send.
  get queuedBytes(): number {
    return this.pending.reduce((total, chunk) => total + chunk.byteLength, 0);
  }

  open(): Promise<void> {
    if (this.currentState !== 'new') {
      return Promise.reject(new Error(`Channel to port ${this.destinationPort} already ${this.currentState}`));
    }

    const connected = new Promise<void>((resolve, reject) => {
      this.connectWaiters.push({ resolve, reject });
    });

    this.setState('connecting');
    this.send(TCP_FLAG_SYN);

    return connected;
  }

  write(data: Uint8Array): void {
    if (this.currentState !== 'connected') {
      throw new Error(`Cannot write to channel in state ${this.currentState}`);
    }
    if (data.byteLength > 0) {
      this.pending.push(data.slice());
      this.flush();
    }
  }

  // usbmuxd closes client connections with a reset; the device does not expect a FIN exchange.
  close(): void {
    if (this.currentState === 'connecting' || this.currentState === 'connected') {
      this.send(TCP_FLAG_RST | TCP_FLAG_ACK);
    }
    this.teardown('closed', new Error('Channel closed'));
  }

  // Called by the mux for every segment addressed to this channel.
  handleSegment(header: TcpHeader, payload: Uint8Array): void {
    this.logger.log(
      'debug',
      `TCP ${header.sourcePort}->${header.destinationPort} ${describeTcpFlags(header.flags)} seq ${
        header.sequence
      } ack ${header.acknowledgement} len ${payload.byteLength}`,
    );

    this.rxAck = header.acknowledgement;
    this.peerWindow = header.window << WINDOW_SHIFT;

    if (header.flags & TCP_FLAG_RST) {
      this.teardown(
        this.currentState === 'connecting' ? 'refused' : 'closed',
        new Error(`Connection to port ${this.destinationPort} refused`),
      );
      return;
    }

    switch (this.currentState) {
      case 'connecting':
        if (header.flags === (TCP_FLAG_SYN | TCP_FLAG_ACK)) {
          this.txSeq = (this.txSeq + 1) >>> 0;
          this.txAck = (header.sequence + 1) >>> 0;
          this.send(TCP_FLAG_ACK);
          this.setState('connected');
          this.connectWaiters.forEach((waiter) => waiter.resolve());
          this.connectWaiters = [];
          this.flush();
        } else {
          this.send(TCP_FLAG_RST);
          this.teardown('refused', new Error(`Unexpected ${describeTcpFlags(header.flags)} while connecting`));
        }
        return;

      case 'connected':
        this.receive(header, payload);
        return;

      default:
        return;
    }
  }

  private receive(header: TcpHeader, payload: Uint8Array): void {
    let deliver = false;

    if (payload.byteLength > 0) {
      if (header.sequence === this.txAck) {
        this.txAck = (this.txAck + payload.byteLength) >>> 0;
        deliver = true;
      } else {
        this.logger.log('warn', `Dropping out of order segment seq ${header.sequence}, expected ${this.txAck}`);
      }
    }

    if (header.flags & TCP_FLAG_FIN) {
      this.txAck = (this.txAck + 1) >>> 0;
    }

    // The device likes it best when we ACK promptly; it stalls once its window is exhausted.
    if (payload.byteLength > 0 || header.flags & TCP_FLAG_FIN) {
      this.send(TCP_FLAG_ACK);
    }

    if (deliver && this.onData) {
      this.onData(payload);
    }

    if (header.flags & TCP_FLAG_FIN) {
      this.send(TCP_FLAG_RST | TCP_FLAG_ACK);
      this.teardown('closed', new Error('Closed by device'));
      return;
    }

    this.flush();
  }

  private flush(): void {
    while (this.currentState === 'connected' && this.pending.length > 0) {
      const inFlight = (this.txSeq - this.rxAck) >>> 0;
      const available = this.peerWindow - inFlight;
      if (available <= 0) {
        this.logger.log('debug', `Device window full, ${this.queuedBytes} bytes queued`);
        return;
      }

      const head = this.pending[0];
      const length = Math.min(head.byteLength, available, this.maxSegmentSize);
      const chunk = head.subarray(0, length);

      if (length === head.byteLength) {
        this.pending.shift();
      } else {
        this.pending[0] = head.subarray(length);
      }

      // Advance before sending: the device may ACK before send() returns.
      const sequence = this.txSeq;
      this.txSeq = (this.txSeq + length) >>> 0;
      this.send(TCP_FLAG_ACK, chunk, sequence);
    }
  }

  private send(flags: number, payload: Uint8Array = new Uint8Array(0), sequence = this.txSeq): void {
    const header: TcpHeader = {
      sourcePort: this.sourcePort,
      destinationPort: this.destinationPort,
      sequence,
      acknowledgement: this.txAck,
      flags,
      window: this.receiveWindow >> WINDOW_SHIFT,
    };
    this.sendSegment(encodeTcpSegment(header, payload));
  }

  private teardown(state: ChannelState, error: Error): void {
    if (this.currentState === 'closed' || this.currentState === 'refused') {
      return;
    }
    this.pending = [];
    this.release();
    this.setState(state);
    this.connectWaiters.forEach((waiter) => waiter.reject(error));
    this.connectWaiters = [];
  }

  private setState(state: ChannelState): void {
    const previous = this.currentState;
    this.currentState = state;
    if (this.onStateChange && previous !== state) {
      this.onStateChange(state, previous);
    }
  }
}
