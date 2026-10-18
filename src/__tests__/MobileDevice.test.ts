import MobileDevice from '../MobileDevice';
import { flush, text } from './helpers/fakeDevice';
import { FakeUsbDevice } from './helpers/fakeUsb';

describe('MobileDevice', () => {
  test('exports the default class from the package entry point', async () => {
    const entry = await import('../webmuxd');
    expect(entry.default).toBe(MobileDevice);
    expect(entry.UsbMux).toBeDefined();
    expect(entry.RemoteChannel).toBeDefined();
  });

  test('is unsupported without navigator.usb', () => {
    expect(MobileDevice.supported()).toBe(false);
  });

  test('opens the usbmux configuration and interface', async () => {
    const usb = new FakeUsbDevice();
    const device = new MobileDevice(usb.asUsbDevice());
    await device.open();

    expect(usb.calls).toEqual(['open', 'selectConfiguration 4', 'claimInterface 1']);
    expect(device.usbInputEndpoint?.endpointNumber).toBe(5);
    expect(device.usbOutputEndpoint?.endpointNumber).toBe(4);
    expect(device.opened).toBe(true);
    await device.close();
  });

  test('throws when the device has no usbmux interface', async () => {
    const usb = new FakeUsbDevice();
    usb.configurations.splice(1, 1);
    await expect(new MobileDevice(usb.asUsbDevice()).open()).rejects.toThrow(/no usbmux interface/);
  });

  test('reads continuously and hands each transfer to handleData', async () => {
    const usb = new FakeUsbDevice();
    const device = new MobileDevice(usb.asUsbDevice());
    const seen: number[] = [];
    device.handleData = (data) => seen.push(data.byteLength);
    await device.open();

    usb.deliver(text('one'));
    usb.deliver(text('three'));
    await flush();
    expect(seen).toEqual([3, 5]);
    await device.close();
  });

  test('sends a zero length packet after a transfer that fills whole packets', async () => {
    const usb = new FakeUsbDevice();
    const device = new MobileDevice(usb.asUsbDevice());
    usb.apple.fromHost = () => undefined;
    await device.open();

    await device.sendData(new Uint8Array(1024));
    await device.sendData(new Uint8Array(100));
    expect(usb.outTransfers.map((t) => t.byteLength)).toEqual([1024, 0, 100]);
    await device.close();
  });

  test('close releases, resets and closes the device', async () => {
    const usb = new FakeUsbDevice();
    const device = new MobileDevice(usb.asUsbDevice());
    await device.open();
    await device.close();
    expect(usb.calls.slice(3)).toEqual(['releaseInterface 1', 'selectConfiguration 1', 'reset', 'close']);
  });

  test('startMux speaks usbmux end to end over USB', async () => {
    const usb = new FakeUsbDevice();
    usb.inChunkSize = 7;
    const device = new MobileDevice(usb.asUsbDevice());
    const mux = await device.startMux();
    expect(mux.state).toBe('ready');

    const channel = await mux.connect(62078);
    const received: string[] = [];
    channel.onData = (data) => received.push(new TextDecoder().decode(data));
    usb.apple.sendTcp(channel.sourcePort, 0x10, text('<plist/>'));
    for (let i = 0; i < 10; i++) await flush();

    expect(received.join('')).toBe('<plist/>');
    expect(device.mux).toBe(mux);
    await device.close();
    expect(channel.state).toBe('closed');
  });
});
