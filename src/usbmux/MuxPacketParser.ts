import { MUX_HEADER_V1_SIZE, MUX_MAX_IN_PACKET } from './protocol';

/**
 * Reassembles complete mux packets from a stream of USB bulk transfers.
 *
 * A single transfer may hold part of a packet or several packets back to back. Every header begins with the
 * protocol and the total packet length, so framing works the same before and after version negotiation.
 */
export default class MuxPacketParser {
  private buffer: Uint8Array = new Uint8Array(0);

  get pendingBytes(): number {
    return this.buffer.byteLength;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    this.buffer = this.buffer.byteLength === 0 ? chunk.slice() : concat(this.buffer, chunk);

    const packets: Uint8Array[] = [];
    let offset = 0;

    while (this.buffer.byteLength - offset >= MUX_HEADER_V1_SIZE) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, MUX_HEADER_V1_SIZE);
      const length = view.getUint32(4);

      if (length < MUX_HEADER_V1_SIZE || length > MUX_MAX_IN_PACKET) {
        this.reset();
        throw new Error(`Corrupt mux stream: packet length ${length}`);
      }
      if (this.buffer.byteLength - offset < length) {
        break;
      }

      packets.push(this.buffer.slice(offset, offset + length));
      offset += length;
    }

    this.buffer = this.buffer.slice(offset);
    return packets;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
  }
}

const concat = (first: Uint8Array, second: Uint8Array): Uint8Array => {
  const result = new Uint8Array(first.byteLength + second.byteLength);
  result.set(first, 0);
  result.set(second, first.byteLength);
  return result;
};
