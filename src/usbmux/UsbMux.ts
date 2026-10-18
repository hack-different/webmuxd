import { Logger, NULL_LOGGER } from '../logger';
import MuxPacketParser from './MuxPacketParser';
import {
  decodeMuxPacket,
  decodeTcpSegment,
  decodeVersion,
  encodeMuxPacket,
  encodeVersion,
  MUX_CONTROL_ERROR,
  MUX_CONTROL_INFO,
  MUX_CONTROL_WARNING,
  MUX_PROTOCOL_CONTROL,
  MUX_PROTOCOL_SETUP,
  MUX_PROTOCOL_TCP,
  MUX_PROTOCOL_VERSION,
  MUX_RECEIVE_MAGIC,
  MUX_SETUP_PAYLOAD,
  MUX_VERSION_MAJOR,
  MUX_VERSION_MINOR,
  MuxPacket,
  MuxVersion,
} from './protocol';
import TcpChannel, { TcpChannelOptions } from './TcpChannel';

export type MuxState = 'new' | 'negotiating' | 'ready' | 'closed';
export type ControlLevel = 'error' | 'warning' | 'info' | 'unknown';

export type MuxTransport = (data: Uint8Array) => unknown;

export interface UsbMuxOptions {
  logger?: Logger;
  channel?: TcpChannelOptions;
}

const MAX_PORT = 0xffff;

/**
 * The host side of the usbmux protocol for one device: version negotiation, the setup packet, sequence numbers,
 * control frames, and demultiplexing TCP segments to channels.
 *
 * Feed it everything read from the device's bulk IN endpoint with `receive()`; it writes to the device through the
 * transport function it was constructed with.
 */
export default class UsbMux {
  onControl: ((level: ControlLevel, message: string) => void) | null = null;

  private currentState: MuxState = 'new';
  private negotiatedVersion: MuxVersion | null = null;
  private txSeq = 0;
  private rxSeq = 0xffff;
  private nextSourcePort = 1;
  private readonly parser = new MuxPacketParser();
  private readonly channels = new Map<number, TcpChannel>();
  private readonly transport: MuxTransport;
  private readonly logger: Logger;
  private readonly channelOptions: TcpChannelOptions;
  private readyWaiters: { resolve: () => void; reject: (error: Error) => void }[] = [];

  constructor(transport: MuxTransport, options: UsbMuxOptions = {}) {
    this.transport = transport;
    this.logger = options.logger ?? NULL_LOGGER;
    this.channelOptions = { logger: this.logger, ...options.channel };
  }

  get state(): MuxState {
    return this.currentState;
  }

  get version(): MuxVersion | null {
    return this.negotiatedVersion;
  }

  get openChannels(): TcpChannel[] {
    return Array.from(this.channels.values());
  }

  // Negotiates the protocol version with the device; resolves once channels can be opened.
  start(): Promise<void> {
    if (this.currentState === 'ready') {
      return Promise.resolve();
    }
    if (this.currentState === 'closed') {
      return Promise.reject(new Error('Mux is closed'));
    }

    const ready = new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });

    if (this.currentState === 'new') {
      this.currentState = 'negotiating';
      this.sendPacket(MUX_PROTOCOL_VERSION, encodeVersion({ major: MUX_VERSION_MAJOR, minor: MUX_VERSION_MINOR }));
    }

    return ready;
  }

  async connect(port: number): Promise<TcpChannel> {
    if (this.currentState !== 'ready') {
      throw new Error(`Cannot connect to port ${port} while mux is ${this.currentState}`);
    }

    const sourcePort = this.allocateSourcePort();
    const channel = new TcpChannel(
      (segment) => this.sendPacket(MUX_PROTOCOL_TCP, segment),
      sourcePort,
      port,
      this.channelOptions,
      () => this.channels.delete(sourcePort),
    );
    this.channels.set(sourcePort, channel);

    await channel.open();

    return channel;
  }

  receive(chunk: Uint8Array): void {
    let packets: Uint8Array[];
    try {
      packets = this.parser.push(chunk);
    } catch (e) {
      this.logger.log('error', `${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    for (const raw of packets) {
      try {
        this.handlePacket(decodeMuxPacket(raw, this.negotiatedVersion?.major ?? 0));
      } catch (e) {
        this.logger.log('error', `Failed to handle mux packet: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  close(): void {
    for (const channel of Array.from(this.channels.values())) {
      channel.close();
    }
    this.channels.clear();
    this.parser.reset();
    this.currentState = 'closed';
    this.readyWaiters.forEach((waiter) => waiter.reject(new Error('Mux closed')));
    this.readyWaiters = [];
  }

  private handlePacket(packet: MuxPacket): void {
    const { header, payload } = packet;
    const version = this.negotiatedVersion?.major ?? 0;

    if (header.protocol !== MUX_PROTOCOL_VERSION && version >= 2) {
      if (header.magic !== MUX_RECEIVE_MAGIC) {
        this.logger.log('warn', `Dropping packet with bad magic ${header.magic?.toString(16) ?? 'none'}`);
        return;
      }
      this.rxSeq = header.rxSeq ?? this.rxSeq;
    }

    switch (header.protocol) {
      case MUX_PROTOCOL_VERSION:
        this.handleVersion(payload);
        return;
      case MUX_PROTOCOL_CONTROL:
        this.handleControl(payload);
        return;
      case MUX_PROTOCOL_TCP:
        this.handleTcp(payload);
        return;
      default:
        this.logger.log('warn', `Unknown mux protocol ${header.protocol} (${header.length} bytes)`);
    }
  }

  private handleVersion(payload: Uint8Array): void {
    if (this.currentState !== 'negotiating') {
      this.logger.log('warn', `Ignoring version packet while ${this.currentState}`);
      return;
    }

    const version = decodeVersion(payload);
    if (version.major !== 1 && version.major !== 2) {
      const error = new Error(`Device speaks unsupported mux version ${version.major}.${version.minor}`);
      this.logger.log('error', error.message);
      this.currentState = 'closed';
      this.readyWaiters.forEach((waiter) => waiter.reject(error));
      this.readyWaiters = [];
      return;
    }

    this.logger.log('info', `Negotiated mux version ${version.major}.${version.minor}`);
    this.negotiatedVersion = version;

    if (version.major >= 2) {
      this.sendPacket(MUX_PROTOCOL_SETUP, Uint8Array.of(MUX_SETUP_PAYLOAD));
    }

    this.currentState = 'ready';
    this.readyWaiters.forEach((waiter) => waiter.resolve());
    this.readyWaiters = [];
  }

  private handleControl(payload: Uint8Array): void {
    if (payload.byteLength === 0) {
      return;
    }
    const levels: { [type: number]: ControlLevel } = {
      [MUX_CONTROL_ERROR]: 'error',
      [MUX_CONTROL_WARNING]: 'warning',
      [MUX_CONTROL_INFO]: 'info',
    };
    const level = levels[payload[0]] ?? 'unknown';
    const message = new TextDecoder().decode(payload.subarray(1)).replace(/\0+$/, '');

    this.logger.log(level === 'info' ? 'info' : 'warn', `Device control ${level}: ${message}`);
    if (this.onControl) {
      this.onControl(level, message);
    }
  }

  private handleTcp(payload: Uint8Array): void {
    const { header, payload: data } = decodeTcpSegment(payload);
    const channel = this.channels.get(header.destinationPort);

    if (!channel || channel.destinationPort !== header.sourcePort) {
      this.logger.log('warn', `No channel for TCP ${header.sourcePort}->${header.destinationPort}`);
      return;
    }

    channel.handleSegment(header, data);
  }

  private sendPacket(protocol: number, payload: Uint8Array): void {
    const version = this.negotiatedVersion?.major ?? 0;

    if (protocol === MUX_PROTOCOL_SETUP) {
      this.txSeq = 0;
      this.rxSeq = 0xffff;
    }

    const packet = encodeMuxPacket({ protocol, length: 0, txSeq: this.txSeq, rxSeq: this.rxSeq }, payload, version);
    if (protocol !== MUX_PROTOCOL_VERSION && version >= 2) {
      this.txSeq = (this.txSeq + 1) & 0xffff;
    }

    const result = this.transport(packet);
    if (result instanceof Promise) {
      result.catch((e: unknown) => {
        this.logger.log('error', `Failed to send mux packet: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }

  private allocateSourcePort(): number {
    for (let attempt = 0; attempt < MAX_PORT; attempt++) {
      const port = this.nextSourcePort;
      this.nextSourcePort = port >= MAX_PORT ? 1 : port + 1;
      if (!this.channels.has(port)) {
        return port;
      }
    }
    throw new Error('No free source ports');
  }
}
