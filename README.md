# WebMuxD

`webmuxd` is a WebUSB implementation of Apple's `usbmuxd` protocol, compatible with [libimobiledevice/usbmuxd](https://github.com/libimobiledevice/usbmuxd).

## Usage

Yarn:
`yarn add webmuxd`

NPM:
`npm add webmuxd`

## How it Works

`webmuxd` has three layers, each usable on its own:

* `MobileDevice` finds the usbmux interface on an Apple device over WebUSB, claims it and pumps its bulk endpoints.
* `UsbMux` and `TcpChannel` are a TypeScript port of the host side of `usbmuxd`: version negotiation, the setup
  packet, sequence numbers, packet reassembly, and the minimal TCP (SYN / SYN-ACK / ACK, prompt ACKs, window flow
  control) that the device expects. With them a page can talk to device services such as `lockdownd` directly.
* `RemoteChannel` connects devices to a server such as [go-webmuxd](https://github.com/hack-different/go-webmuxd)
  over a WebSocket, using the protobuf protocol in [`src/remote/transport.proto`](src/remote/transport.proto).

### Talking to the device in the browser

```ts
import MobileDevice, { CONSOLE_LOGGER } from 'webmuxd';

MobileDevice.logger = CONSOLE_LOGGER;
const device = await MobileDevice.selectDevice();
const mux = await device.startMux();

const lockdown = await mux.connect(62078);
lockdown.onData = (data) => console.log('lockdownd replied', data);
lockdown.write(request); // length-prefixed plist
```

### Relaying to a server

```ts
import MobileDevice, { RemoteChannel } from 'webmuxd';

const remote = new RemoteChannel({ url: 'wss://example.com/v1/device', reopen: true, mode: 'raw' });
for (const device of await MobileDevice.getDevices()) {
  await remote.bindDevice(device);
}
```

`RemoteChannel` has two modes, chosen per device in the `DeviceConnected` message:

* `raw` (the default) is the original protocol that `go-webmuxd` speaks today: the server runs usbmux and the
  browser relays bytes. The browser now reassembles USB transfers so every `DataFromDevice` carries complete mux
  packets.
* `mux` runs usbmux in the browser. The server opens channels to device ports with `OpenChannel` and exchanges
  stream bytes with `ChannelData`, so framing and ACKs never cross the WebSocket. This needs server support.

The example app in [webmuxd-example](https://github.com/hack-different/webmuxd-example) shows the pieces wired into
a UI.

## Building

If you wish to create your own build it's rather simple:
`yarn run build`

`yarn test`, `yarn lint` and `yarn typecheck` run the same checks as CI. After editing `transport.proto`, regenerate
`src/remote/transport.ts` with `yarn proto` (needs `protoc` on your `PATH`).

## Developing

The simplest way to build, develop and diagnose is using the `XHC20` USB capture on macOS, and optionally `demuxusb`

https://www.umpah.net/how-to-sniff-usb-traffic-reverse-engineer-usb-device-interactions/

Using a Chromebook as an endpoint:

https://blog.rickmark.me/puppeteer-with-chromeos/

## Contributing and License

This project is happy to accept PRs and other contributions.  It is free for commercial use under the MIT license, 
I would love to see it credited if so!

## Roadmap

Done:

* Handle all `usbmuxd` framing and ACKs in script to reduce RTT (`UsbMux`, `TcpChannel`)
* Standardize the WebSocket protocol and move it from `webmuxd-example` into `webmuxd`
  (`MobileDevice`, `RemoteChannel`, `transport.proto` / `transport.ts`)

Still open, outside this package:

* Support `mux` mode in `go-webmuxd`, and switch `webmuxd-example` to depend on this package
* Factor out "common UI elements" to `webmuxd-ui`
  * Device Picker
  * Device Info
* Improve `go-webmuxd` as a multi-session "meet me" service
