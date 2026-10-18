import UsbMux from '../usbmux/UsbMux';
import {
  MUX_CONTROL_INFO,
  MUX_PROTOCOL_SETUP,
  MUX_PROTOCOL_TCP,
  MUX_PROTOCOL_VERSION,
  TCP_FLAG_ACK,
  TCP_FLAG_FIN,
  TCP_FLAG_RST,
  TCP_FLAG_SYN,
} from '../usbmux/protocol';
import { FakeAppleDevice, text } from './helpers/fakeDevice';

const pair = (): { mux: UsbMux; device: FakeAppleDevice } => {
  const device = new FakeAppleDevice();
  const mux = new UsbMux((data) => device.fromHost(data));
  device.toHost = (data) => mux.receive(data);
  return { mux, device };
};

describe('UsbMux handshake', () => {
  test('negotiates version 2 and sends setup with reset sequence numbers', async () => {
    const { mux, device } = pair();
    await mux.start();

    expect(mux.state).toBe('ready');
    expect(mux.version).toEqual({ major: 2, minor: 0 });

    const [version, setup] = device.received;
    expect(version.header).toEqual({ protocol: MUX_PROTOCOL_VERSION, length: 20 });
    expect(setup.header.protocol).toBe(MUX_PROTOCOL_SETUP);
    expect(setup.header.txSeq).toBe(0);
    expect(setup.header.rxSeq).toBe(0xffff);
    expect(Array.from(setup.payload)).toEqual([0x07]);
  });

  test('supports version 1 devices without magic or sequence numbers', async () => {
    const { mux, device } = pair();
    device.version = 1;
    await mux.start();
    expect(mux.version?.major).toBe(1);
    expect(device.received.map((p) => p.header.protocol)).toEqual([MUX_PROTOCOL_VERSION]);

    const channel = await mux.connect(62078);
    expect(channel.state).toBe('connected');
    expect(device.received[1].header.magic).toBeUndefined();
  });

  test('rejects unsupported versions', async () => {
    const { mux, device } = pair();
    device.version = 9;
    await expect(mux.start()).rejects.toThrow(/unsupported mux version 9/);
    expect(mux.state).toBe('closed');
  });

  test('cannot connect before negotiation', async () => {
    const mux = new UsbMux(() => undefined);
    await expect(mux.connect(62078)).rejects.toThrow(/while mux is new/);
  });

  test('reports control frames', async () => {
    const { mux, device } = pair();
    await mux.start();
    const control = jest.fn();
    mux.onControl = control;
    device.sendControl(MUX_CONTROL_INFO, 'hello\0');
    expect(control).toHaveBeenCalledWith('info', 'hello');
  });

  test('increments tx sequence on every v2 packet', async () => {
    const { mux, device } = pair();
    await mux.start();
    await mux.connect(62078);
    const sequences = device.received.slice(1).map((p) => p.header.txSeq);
    expect(sequences).toEqual([0, 1, 2]);
  });
});

describe('TcpChannel over UsbMux', () => {
  test('performs the SYN, SYN-ACK, ACK handshake', async () => {
    const { mux, device } = pair();
    await mux.start();
    const channel = await mux.connect(62078);

    expect(channel.state).toBe('connected');
    const [syn, ack] = device.segments;
    expect(syn.header).toMatchObject({
      sourcePort: 1,
      destinationPort: 62078,
      sequence: 0,
      acknowledgement: 0,
      flags: TCP_FLAG_SYN,
    });
    expect(ack.header).toMatchObject({ sequence: 1, acknowledgement: 1, flags: TCP_FLAG_ACK });
    // 131072 >> 8
    expect(syn.header.window).toBe(512);
  });

  test('rejects when the device resets the SYN', async () => {
    const { mux } = pair();
    await mux.start();
    await expect(mux.connect(1234)).rejects.toThrow(/refused/);
    expect(mux.openChannels).toEqual([]);
  });

  test('allocates distinct source ports', async () => {
    const { mux } = pair();
    await mux.start();
    const first = await mux.connect(62078);
    const second = await mux.connect(62078);
    expect(first.sourcePort).not.toBe(second.sourcePort);
  });

  test('delivers device data in order and ACKs it immediately', async () => {
    const { mux, device } = pair();
    await mux.start();
    const channel = await mux.connect(62078);
    const received: string[] = [];
    channel.onData = (data) => received.push(new TextDecoder().decode(data));

    device.sendTcp(channel.sourcePort, TCP_FLAG_ACK, text('hello'));
    device.sendTcp(channel.sourcePort, TCP_FLAG_ACK, text('world!'));

    expect(received).toEqual(['hello', 'world!']);
    const acks = device.segments.slice(2);
    expect(acks.map((s) => s.header.acknowledgement)).toEqual([1 + 5, 1 + 5 + 6]);
    expect(acks.every((s) => s.header.flags === TCP_FLAG_ACK && s.payload.byteLength === 0)).toBe(true);
  });

  test('sends host data with advancing sequence numbers', async () => {
    const { mux, device } = pair();
    await mux.start();
    const channel = await mux.connect(62078);
    channel.write(text('abc'));
    channel.write(text('defg'));

    const data = device.segments.filter((s) => s.payload.byteLength > 0);
    expect(data.map((s) => s.header.sequence)).toEqual([1, 4]);
    expect(new TextDecoder().decode(device.dataFor(channel.sourcePort))).toBe('abcdefg');
  });

  test('stays within the device window and resumes on ACK', async () => {
    const { mux, device } = pair();
    device.window = 1; // 256 bytes
    device.autoAck = false;
    await mux.start();
    const channel = await mux.connect(62078);

    channel.write(new Uint8Array(1000).fill(7));
    expect(device.dataFor(channel.sourcePort).byteLength).toBe(256);
    expect(channel.queuedBytes).toBe(744);

    device.sendTcp(channel.sourcePort, TCP_FLAG_ACK);
    expect(device.dataFor(channel.sourcePort).byteLength).toBe(512);

    device.autoAck = true;
    device.sendTcp(channel.sourcePort, TCP_FLAG_ACK);
    expect(device.dataFor(channel.sourcePort).byteLength).toBe(1000);
    expect(channel.queuedBytes).toBe(0);
  });

  test('splits writes larger than the maximum segment', async () => {
    const device = new FakeAppleDevice();
    device.window = 0xffff;
    const mux = new UsbMux((data) => device.fromHost(data), { channel: { maxSegmentSize: 100 } });
    device.toHost = (data) => mux.receive(data);
    await mux.start();
    const channel = await mux.connect(62078);

    channel.write(new Uint8Array(250));
    const sizes = device.segments.filter((s) => s.payload.byteLength > 0).map((s) => s.payload.byteLength);
    expect(sizes).toEqual([100, 100, 50]);
  });

  test('close sends a reset and releases the port', async () => {
    const { mux, device } = pair();
    await mux.start();
    const channel = await mux.connect(62078);
    const states: string[] = [];
    channel.onStateChange = (state) => states.push(state);
    channel.close();

    expect(device.segments[device.segments.length - 1].header.flags).toBe(TCP_FLAG_RST | TCP_FLAG_ACK);
    expect(states).toEqual(['closed']);
    expect(mux.openChannels).toEqual([]);
    expect(() => channel.write(text('x'))).toThrow(/state closed/);
  });

  test('device reset closes the channel', async () => {
    const { mux, device } = pair();
    await mux.start();
    const channel = await mux.connect(62078);
    device.sendTcp(channel.sourcePort, TCP_FLAG_RST);
    expect(channel.state).toBe('closed');
  });

  test('device FIN is acknowledged and closes the channel', async () => {
    const { mux, device } = pair();
    await mux.start();
    const channel = await mux.connect(62078);
    device.sendTcp(channel.sourcePort, TCP_FLAG_FIN | TCP_FLAG_ACK);
    expect(channel.state).toBe('closed');
    const ack = device.segments.find((s) => s.header.flags === TCP_FLAG_ACK && s.header.acknowledgement === 2);
    expect(ack).toBeDefined();
  });

  test('drops packets with the wrong magic', async () => {
    const { mux, device } = pair();
    await mux.start();
    const channel = await mux.connect(62078);
    const onData = jest.fn();
    channel.onData = onData;

    // Hand-build a TCP packet whose magic is the host's rather than the device's.
    const { encodeMuxPacket, encodeTcpSegment } = await import('../usbmux/protocol');
    const segment = encodeTcpSegment(
      {
        sourcePort: 62078,
        destinationPort: channel.sourcePort,
        sequence: 1,
        acknowledgement: 1,
        flags: TCP_FLAG_ACK,
        window: 512,
      },
      text('nope'),
    );
    mux.receive(encodeMuxPacket({ protocol: MUX_PROTOCOL_TCP, length: 0 }, segment, 2));
    expect(onData).not.toHaveBeenCalled();
  });

  test('closing the mux closes every channel', async () => {
    const { mux } = pair();
    await mux.start();
    const a = await mux.connect(62078);
    const b = await mux.connect(62078);
    mux.close();
    expect([a.state, b.state]).toEqual(['closed', 'closed']);
    expect(mux.state).toBe('closed');
  });
});
