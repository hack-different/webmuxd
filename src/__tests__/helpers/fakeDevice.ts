import {
  decodeMuxPacket,
  decodeTcpSegment,
  decodeVersion,
  encodeMuxPacket,
  encodeTcpSegment,
  encodeVersion,
  MUX_PROTOCOL_CONTROL,
  MUX_PROTOCOL_SETUP,
  MUX_PROTOCOL_TCP,
  MUX_PROTOCOL_VERSION,
  MUX_RECEIVE_MAGIC,
  MuxPacket,
  TCP_FLAG_ACK,
  TCP_FLAG_RST,
  TCP_FLAG_SYN,
  TcpHeader,
} from '../../usbmux/protocol';
import MuxPacketParser from '../../usbmux/MuxPacketParser';

export interface SentSegment {
  packet: MuxPacket;
  header: TcpHeader;
  payload: Uint8Array;
}

/**
 * Plays the device side of usbmux: answers the version handshake, accepts or refuses SYNs, and records
 * everything the host sends so tests can assert on the wire format.
 */
export class FakeAppleDevice {
  readonly received: MuxPacket[] = [];
  readonly segments: SentSegment[] = [];
  readonly listening = new Set<number>([62078]);
  // What the device advertises, already shifted down by 8 as on the wire.
  window = 512;
  autoAck = true;
  version = 2;
  toHost: (data: Uint8Array) => void = () => undefined;

  private parser = new MuxPacketParser();
  private txSeq = 0;
  private negotiated = 0;
  private tcp = new Map<number, { seq: number; ack: number; port: number }>();

  // Bytes the host wrote to the bulk OUT endpoint.
  fromHost(data: Uint8Array): void {
    for (const raw of this.parser.push(data)) {
      const packet = decodeMuxPacket(raw, this.negotiated);
      this.received.push(packet);
      this.handle(packet);
    }
  }

  sendToHost(protocol: number, payload: Uint8Array): void {
    const packet = encodeMuxPacket(
      { protocol, length: 0, magic: MUX_RECEIVE_MAGIC, txSeq: this.txSeq, rxSeq: this.txSeq },
      payload,
      protocol === MUX_PROTOCOL_VERSION ? 0 : this.negotiated,
    );
    this.txSeq = (this.txSeq + 1) & 0xffff;
    this.toHost(packet);
  }

  sendTcp(hostPort: number, flags: number, payload: Uint8Array = new Uint8Array(0)): void {
    const state = this.tcp.get(hostPort);
    if (!state) throw new Error(`no connection from host port ${hostPort}`);
    this.sendToHost(
      MUX_PROTOCOL_TCP,
      encodeTcpSegment(
        {
          sourcePort: state.port,
          destinationPort: hostPort,
          sequence: state.seq,
          acknowledgement: state.ack,
          flags,
          window: this.window,
        },
        payload,
      ),
    );
    state.seq += payload.byteLength;
  }

  sendControl(type: number, message: string): void {
    const text = new TextEncoder().encode(message);
    const payload = new Uint8Array(text.byteLength + 1);
    payload[0] = type;
    payload.set(text, 1);
    this.sendToHost(MUX_PROTOCOL_CONTROL, payload);
  }

  dataFor(hostPort: number): Uint8Array {
    const chunks = this.segments.filter((s) => s.header.sourcePort === hostPort).map((s) => s.payload);
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    chunks.forEach((c) => {
      out.set(c, offset);
      offset += c.byteLength;
    });
    return out;
  }

  private handle(packet: MuxPacket): void {
    switch (packet.header.protocol) {
      case MUX_PROTOCOL_VERSION: {
        decodeVersion(packet.payload);
        // The host may answer with setup before this call returns, so switch header formats first.
        const reply = encodeVersion({ major: this.version, minor: 0 });
        this.negotiated = this.version;
        this.sendToHost(MUX_PROTOCOL_VERSION, reply);
        return;
      }
      case MUX_PROTOCOL_SETUP:
        return;
      case MUX_PROTOCOL_TCP: {
        const { header, payload } = decodeTcpSegment(packet.payload);
        this.segments.push({ packet, header, payload });
        if (header.flags === TCP_FLAG_SYN) {
          this.tcp.set(header.sourcePort, { seq: 0, ack: header.sequence + 1, port: header.destinationPort });
          this.sendTcp(
            header.sourcePort,
            this.listening.has(header.destinationPort) ? TCP_FLAG_SYN | TCP_FLAG_ACK : TCP_FLAG_RST,
          );
          const state = this.tcp.get(header.sourcePort);
          if (state && this.listening.has(header.destinationPort)) state.seq += 1;
          return;
        }
        const state = this.tcp.get(header.sourcePort);
        if (state && payload.byteLength > 0) {
          state.ack = header.sequence + payload.byteLength;
          if (this.autoAck) this.sendTcp(header.sourcePort, TCP_FLAG_ACK);
        }
        return;
      }
      default:
        return;
    }
  }
}

export const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
export const text = (value: string): Uint8Array => new TextEncoder().encode(value);
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
