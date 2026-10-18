import MobileDevice from '../MobileDevice';
import RemoteChannel, { WebSocketLike } from '../remote/RemoteChannel';
import { ChannelState, ClientMessage, ServerMessage } from '../remote/transport';
import { encodeMuxPacket, MUX_PROTOCOL_TCP, TCP_FLAG_ACK } from '../usbmux/protocol';
import { flush, text } from './helpers/fakeDevice';
import { FakeUsbDevice } from './helpers/fakeUsb';

class FakeSocket implements WebSocketLike {
  binaryType = 'blob';
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: ServerMessage[] = [];

  constructor(readonly url: string) {}

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  send(data: Uint8Array): void {
    this.sent.push(ServerMessage.decode(data));
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  fromServer(message: ClientMessage): void {
    const data = ClientMessage.encode(message).finish();
    this.onmessage?.({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
  }

  cases(): string[] {
    return this.sent.map((m) => m.message?.$case ?? 'none');
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await flush();
};

const setup = (mode: 'raw' | 'mux') => {
  const sockets: FakeSocket[] = [];
  const remote = new RemoteChannel({
    url: 'wss://relay.example/v1/device',
    mode,
    reopen: true,
    webSocketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  const usb = new FakeUsbDevice();
  const device = new MobileDevice(usb.asUsbDevice());
  return { remote, sockets, usb, device };
};

describe('RemoteChannel', () => {
  test('defaults to raw mode on the current host', () => {
    const remote = new RemoteChannel({ webSocketFactory: (url) => new FakeSocket(url) });
    expect(remote.url).toBe('wss://localhost/v1/device');
    expect(remote.mode).toBe('raw');
  });

  test('queues messages until the socket opens', async () => {
    const { remote, sockets, device } = setup('raw');
    await remote.bindDevice(device);
    expect(sockets[0].sent).toEqual([]);

    sockets[0].open();
    expect(sockets[0].cases()).toEqual(['deviceConnected']);
    const connected = sockets[0].sent[0].message;
    expect(connected?.$case === 'deviceConnected' && connected.value).toMatchObject({
      serialNumber: device.serialNumber,
      vendorId: 0x5ac,
      productId: 0x12a8,
      productName: 'iPhone',
      muxInClient: false,
    });
    await device.close();
  });

  describe('raw mode', () => {
    test('forwards only complete mux packets from the device', async () => {
      const { remote, sockets, usb, device } = setup('raw');
      sockets[0].open();
      await remote.bindDevice(device);

      const packet = encodeMuxPacket(
        { protocol: MUX_PROTOCOL_TCP, length: 0, magic: 0xfaceface },
        new Uint8Array(40),
        2,
      );
      usb.deliver(packet.slice(0, 10));
      usb.deliver(Uint8Array.from([...packet.slice(10), ...packet.slice(0, 3)]));
      await settle();

      const forwarded = sockets[0].sent.filter((m) => m.message?.$case === 'fromDevice');
      expect(forwarded).toHaveLength(1);
      const message = forwarded[0].message;
      expect(message?.$case === 'fromDevice' && Array.from(message.value.data)).toEqual(Array.from(packet));
      await device.close();
    });

    test('writes server data to the device and reports the result', async () => {
      const { remote, sockets, usb, device } = setup('raw');
      usb.apple.fromHost = () => undefined;
      sockets[0].open();
      await remote.bindDevice(device);

      sockets[0].fromServer({
        message: {
          $case: 'toDevice',
          value: { serialNumber: device.serialNumber, correlationId: 'abc', data: text('hi') },
        },
      });
      sockets[0].fromServer({
        message: { $case: 'toDevice', value: { serialNumber: 'unknown', correlationId: 'def', data: text('hi') } },
      });
      await settle();

      expect(usb.outTransfers.map((t) => new TextDecoder().decode(t))).toEqual(['hi']);
      const results = sockets[0].sent
        .map((m) => m.message)
        .filter((m) => m?.$case === 'toDeviceResult')
        .map((m) => m?.$case === 'toDeviceResult' && m.value);
      expect(results).toEqual([
        { correlationId: 'def', success: false },
        { correlationId: 'abc', success: true },
      ]);
      await device.close();
    });
  });

  describe('mux mode', () => {
    test('negotiates usbmux locally and relays channel bytes', async () => {
      const { remote, sockets, usb, device } = setup('mux');
      sockets[0].open();
      await remote.bindDevice(device);
      expect(device.mux?.state).toBe('ready');
      const connected = sockets[0].sent[0].message;
      expect(connected?.$case === 'deviceConnected' && connected.value.muxInClient).toBe(true);

      sockets[0].fromServer({
        message: { $case: 'openChannel', value: { serialNumber: device.serialNumber, channelId: 7, port: 62078 } },
      });
      await settle();
      const state = sockets[0].sent.map((m) => m.message).find((m) => m?.$case === 'channelState');
      expect(state?.$case === 'channelState' && state.value).toEqual({
        serialNumber: device.serialNumber,
        channelId: 7,
        state: ChannelState.CHANNEL_STATE_CONNECTED,
        reason: '',
      });

      sockets[0].fromServer({
        message: {
          $case: 'channelData',
          value: { serialNumber: device.serialNumber, channelId: 7, data: text('ping') },
        },
      });
      await settle();
      const hostPort = usb.apple.segments[0].header.sourcePort;
      expect(new TextDecoder().decode(usb.apple.dataFor(hostPort))).toBe('ping');

      usb.apple.sendTcp(hostPort, TCP_FLAG_ACK, text('pong'));
      await settle();
      const data = sockets[0].sent.map((m) => m.message).find((m) => m?.$case === 'channelData');
      expect(data?.$case === 'channelData' && new TextDecoder().decode(data.value.data)).toBe('pong');

      sockets[0].fromServer({
        message: { $case: 'closeChannel', value: { serialNumber: device.serialNumber, channelId: 7 } },
      });
      await settle();
      const closed = sockets[0].sent.map((m) => m.message).filter((m) => m?.$case === 'channelState');
      expect(closed[closed.length - 1]?.$case === 'channelState' && closed[closed.length - 1]).toMatchObject({
        value: { state: ChannelState.CHANNEL_STATE_CLOSED },
      });
      await device.close();
    });

    test('reports refused ports', async () => {
      const { remote, sockets, device } = setup('mux');
      sockets[0].open();
      await remote.bindDevice(device);
      sockets[0].fromServer({
        message: { $case: 'openChannel', value: { serialNumber: device.serialNumber, channelId: 1, port: 9 } },
      });
      await settle();
      const state = sockets[0].sent.map((m) => m.message).find((m) => m?.$case === 'channelState');
      expect(state?.$case === 'channelState' && state.value.state).toBe(ChannelState.CHANNEL_STATE_REFUSED);
      await device.close();
    });

    test('reopens the socket, drops channels and announces devices again', async () => {
      const { remote, sockets, device } = setup('mux');
      sockets[0].open();
      await remote.bindDevice(device);
      sockets[0].fromServer({
        message: { $case: 'openChannel', value: { serialNumber: device.serialNumber, channelId: 1, port: 62078 } },
      });
      await settle();

      sockets[0].close();
      expect(sockets).toHaveLength(2);
      sockets[1].open();
      expect(sockets[1].cases()).toEqual(['deviceConnected']);
      expect(remote.devices[device.serialNumber].channels.size).toBe(0);

      remote.close();
      expect(sockets).toHaveLength(2);
      await device.close();
    });
  });

  test('unbindDevice announces the disconnect', async () => {
    const { remote, sockets, device } = setup('raw');
    sockets[0].open();
    await remote.bindDevice(device);
    remote.unbindDevice(device);
    expect(sockets[0].cases()).toEqual(['deviceConnected', 'deviceDisconnected']);
    expect(device.handleData).toBeNull();
    await device.close();
  });
});
