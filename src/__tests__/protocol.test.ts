import MuxPacketParser from '../usbmux/MuxPacketParser';
import {
  decodeMuxPacket,
  decodeTcpSegment,
  decodeVersion,
  encodeMuxPacket,
  encodeTcpSegment,
  encodeVersion,
  MUX_PROTOCOL_TCP,
  MUX_PROTOCOL_VERSION,
  MUX_SEND_MAGIC,
  TCP_FLAG_ACK,
  TCP_FLAG_SYN,
} from '../usbmux/protocol';
import { bytes } from './helpers/fakeDevice';

describe('mux headers', () => {
  test('version packets use the 8 byte header', () => {
    const packet = encodeMuxPacket(
      { protocol: MUX_PROTOCOL_VERSION, length: 0 },
      encodeVersion({ major: 2, minor: 0 }),
      0,
    );
    expect(Array.from(packet)).toEqual([0, 0, 0, 0, 0, 0, 0, 20, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(decodeVersion(decodeMuxPacket(packet, 0).payload)).toEqual({ major: 2, minor: 0 });
  });

  test('v2 packets carry magic and sequence numbers big endian', () => {
    const packet = encodeMuxPacket(
      { protocol: MUX_PROTOCOL_TCP, length: 0, txSeq: 0x0102, rxSeq: 0xffff },
      bytes(9),
      2,
    );
    expect(Array.from(packet)).toEqual([0, 0, 0, 6, 0, 0, 0, 17, 0xfe, 0xed, 0xfa, 0xce, 1, 2, 0xff, 0xff, 9]);

    const decoded = decodeMuxPacket(packet, 2);
    expect(decoded.header).toEqual({ protocol: 6, length: 17, magic: MUX_SEND_MAGIC, txSeq: 0x0102, rxSeq: 0xffff });
    expect(Array.from(decoded.payload)).toEqual([9]);
  });

  test('rejects a length shorter than the header', () => {
    expect(() => decodeMuxPacket(bytes(0, 0, 0, 6, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0), 2)).toThrow(/Malformed/);
  });
});

describe('tcp segments', () => {
  test('round trip', () => {
    const header = {
      sourcePort: 1,
      destinationPort: 62078,
      sequence: 0xfffffffe,
      acknowledgement: 7,
      flags: TCP_FLAG_SYN | TCP_FLAG_ACK,
      window: 512,
    };
    const segment = encodeTcpSegment(header, bytes(1, 2, 3));
    expect(segment.byteLength).toBe(23);
    expect(segment[12]).toBe(0x50);
    expect(segment[13]).toBe(TCP_FLAG_SYN | TCP_FLAG_ACK);

    const decoded = decodeTcpSegment(segment);
    expect(decoded.header).toEqual(header);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3]);
  });
});

describe('MuxPacketParser', () => {
  const packetA = encodeMuxPacket({ protocol: MUX_PROTOCOL_TCP, length: 0 }, bytes(1, 2, 3, 4), 2);
  const packetB = encodeMuxPacket({ protocol: MUX_PROTOCOL_TCP, length: 0 }, bytes(5), 2);

  test('reassembles a packet split across transfers', () => {
    const parser = new MuxPacketParser();
    expect(parser.push(packetA.subarray(0, 5))).toEqual([]);
    expect(parser.push(packetA.subarray(5, 12))).toEqual([]);
    const packets = parser.push(packetA.subarray(12));
    expect(packets.map((p) => Array.from(p))).toEqual([Array.from(packetA)]);
    expect(parser.pendingBytes).toBe(0);
  });

  test('splits coalesced packets and keeps the remainder', () => {
    const parser = new MuxPacketParser();
    const joined = new Uint8Array(packetA.byteLength + packetB.byteLength);
    joined.set(packetA);
    joined.set(packetB, packetA.byteLength);

    const packets = parser.push(joined.subarray(0, joined.byteLength - 3));
    expect(packets.map((p) => Array.from(p))).toEqual([Array.from(packetA)]);
    expect(parser.pendingBytes).toBe(packetB.byteLength - 3);
    expect(parser.push(joined.subarray(joined.byteLength - 3)).map((p) => Array.from(p))).toEqual([
      Array.from(packetB),
    ]);
  });

  test('throws and resets on a corrupt length', () => {
    const parser = new MuxPacketParser();
    expect(() => parser.push(bytes(0, 0, 0, 6, 0, 0, 0, 2))).toThrow(/Corrupt/);
    expect(parser.pendingBytes).toBe(0);
  });

  test('copies its input so callers may reuse buffers', () => {
    const parser = new MuxPacketParser();
    const scratch = packetA.slice();
    const [packet] = parser.push(scratch);
    scratch.fill(0);
    expect(Array.from(packet)).toEqual(Array.from(packetA));
  });

  test('flag constant sanity', () => {
    expect(TCP_FLAG_ACK).toBe(0x10);
  });
});
