// Wire format of Apple's usbmux protocol as spoken over the USB bulk endpoints, mirroring
// libimobiledevice/usbmuxd `device.c`. Every integer on the wire is big endian.

export const MUX_PROTOCOL_VERSION = 0;
export const MUX_PROTOCOL_CONTROL = 1;
export const MUX_PROTOCOL_SETUP = 2;
export const MUX_PROTOCOL_TCP = 6;

export const MUX_SEND_MAGIC = 0xfeedface;
export const MUX_RECEIVE_MAGIC = 0xfaceface;

// Version 1 headers (and the version handshake itself) carry only protocol and length.
export const MUX_HEADER_V1_SIZE = 8;
// Version 2 headers add a magic and a pair of sequence numbers.
export const MUX_HEADER_V2_SIZE = 16;
export const MUX_VERSION_PAYLOAD_SIZE = 12;

export const MUX_VERSION_MAJOR = 2;
export const MUX_VERSION_MINOR = 0;
// usbmuxd sends this single byte as the payload of the setup packet.
export const MUX_SETUP_PAYLOAD = 0x07;

export const MUX_CONTROL_ERROR = 0x03;
export const MUX_CONTROL_WARNING = 0x05;
export const MUX_CONTROL_INFO = 0x07;

// Largest packet usbmuxd will hand to the device in one bulk transfer (USB_MTU).
export const MUX_MAX_OUT_PACKET = 3 * 16384;
// Largest packet we will accept from the device before declaring the stream corrupt.
export const MUX_MAX_IN_PACKET = 1024 * 1024;

export const TCP_HEADER_SIZE = 20;
export const TCP_FLAG_FIN = 0x01;
export const TCP_FLAG_SYN = 0x02;
export const TCP_FLAG_RST = 0x04;
export const TCP_FLAG_PSH = 0x08;
export const TCP_FLAG_ACK = 0x10;
export const TCP_FLAG_URG = 0x20;

export interface MuxHeader {
  protocol: number;
  length: number;
  magic?: number;
  txSeq?: number;
  rxSeq?: number;
}

export interface MuxPacket {
  header: MuxHeader;
  payload: Uint8Array;
  // The packet exactly as it appeared on the wire, header included.
  raw: Uint8Array;
}

export interface MuxVersion {
  major: number;
  minor: number;
}

export interface TcpHeader {
  sourcePort: number;
  destinationPort: number;
  sequence: number;
  acknowledgement: number;
  flags: number;
  window: number;
}

const viewOf = (data: Uint8Array): DataView => new DataView(data.buffer, data.byteOffset, data.byteLength);

/**
 * Size of the mux header for a packet, given the negotiated protocol version.
 *
 * @param protocol - the mux protocol of the packet
 * @param version - the negotiated major version, 0 before negotiation
 * @returns the header size in bytes
 */
export const muxHeaderSize = (protocol: number, version: number): number =>
  protocol === MUX_PROTOCOL_VERSION || version < 2 ? MUX_HEADER_V1_SIZE : MUX_HEADER_V2_SIZE;

export const encodeMuxPacket = (header: MuxHeader, payload: Uint8Array, version: number): Uint8Array => {
  const headerSize = muxHeaderSize(header.protocol, version);
  const packet = new Uint8Array(headerSize + payload.byteLength);
  const view = viewOf(packet);

  view.setUint32(0, header.protocol);
  view.setUint32(4, packet.byteLength);
  if (headerSize === MUX_HEADER_V2_SIZE) {
    view.setUint32(8, header.magic ?? MUX_SEND_MAGIC);
    view.setUint16(12, header.txSeq ?? 0);
    view.setUint16(14, header.rxSeq ?? 0);
  }
  packet.set(payload, headerSize);

  return packet;
};

export const decodeMuxPacket = (raw: Uint8Array, version: number): MuxPacket => {
  const view = viewOf(raw);
  const protocol = view.getUint32(0);
  const length = view.getUint32(4);
  const headerSize = muxHeaderSize(protocol, version);

  if (length < headerSize || length > raw.byteLength) {
    throw new Error(`Malformed mux packet: protocol ${protocol} length ${length} of ${raw.byteLength} bytes`);
  }

  const header: MuxHeader = { protocol, length };
  if (headerSize === MUX_HEADER_V2_SIZE) {
    header.magic = view.getUint32(8);
    header.txSeq = view.getUint16(12);
    header.rxSeq = view.getUint16(14);
  }

  return { header, payload: raw.subarray(headerSize, length), raw: raw.subarray(0, length) };
};

export const encodeVersion = (version: MuxVersion): Uint8Array => {
  const payload = new Uint8Array(MUX_VERSION_PAYLOAD_SIZE);
  const view = viewOf(payload);
  view.setUint32(0, version.major);
  view.setUint32(4, version.minor);
  view.setUint32(8, 0);
  return payload;
};

export const decodeVersion = (payload: Uint8Array): MuxVersion => {
  if (payload.byteLength < 8) {
    throw new Error(`Version payload too short (${payload.byteLength} bytes)`);
  }
  const view = viewOf(payload);
  return { major: view.getUint32(0), minor: view.getUint32(4) };
};

export const encodeTcpSegment = (header: TcpHeader, payload: Uint8Array): Uint8Array => {
  const segment = new Uint8Array(TCP_HEADER_SIZE + payload.byteLength);
  const view = viewOf(segment);

  view.setUint16(0, header.sourcePort);
  view.setUint16(2, header.destinationPort);
  view.setUint32(4, header.sequence >>> 0);
  view.setUint32(8, header.acknowledgement >>> 0);
  // Data offset in 32-bit words lives in the high nibble.
  view.setUint8(12, (TCP_HEADER_SIZE / 4) << 4);
  view.setUint8(13, header.flags);
  view.setUint16(14, header.window);
  // Checksum and urgent pointer are unused by usbmux.
  segment.set(payload, TCP_HEADER_SIZE);

  return segment;
};

export const decodeTcpSegment = (segment: Uint8Array): { header: TcpHeader; payload: Uint8Array } => {
  if (segment.byteLength < TCP_HEADER_SIZE) {
    throw new Error(`TCP segment too short (${segment.byteLength} bytes)`);
  }
  const view = viewOf(segment);
  const offset = (view.getUint8(12) >> 4) * 4;
  const header: TcpHeader = {
    sourcePort: view.getUint16(0),
    destinationPort: view.getUint16(2),
    sequence: view.getUint32(4),
    acknowledgement: view.getUint32(8),
    flags: view.getUint8(13),
    window: view.getUint16(14),
  };

  return { header, payload: segment.subarray(Math.max(offset, TCP_HEADER_SIZE)) };
};

export const describeTcpFlags = (flags: number): string => {
  const names: string[] = [];
  if (flags & TCP_FLAG_SYN) names.push('SYN');
  if (flags & TCP_FLAG_ACK) names.push('ACK');
  if (flags & TCP_FLAG_PSH) names.push('PSH');
  if (flags & TCP_FLAG_FIN) names.push('FIN');
  if (flags & TCP_FLAG_RST) names.push('RST');
  if (flags & TCP_FLAG_URG) names.push('URG');
  return names.join('|') || 'none';
};
