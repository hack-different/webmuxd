# WebMuxD

`webmuxd` is a WebUSB implementation of Apple's `usbmuxd` protocol, compatible with [libimobiledevice/usbmuxd](https://github.com/libimobiledevice/usbmuxd).

## Usage

Yarn:
`yarn add webmuxd`

NPM:
`npm add webmuxd`

## How it Works

In this repo you will find `MobileDevice.ts`.  This is a node module that provides the client side implementation of 
connecting to the WebUSB API surface and configuring the message pump.  You can see a more complete example and
implementation of this by looking at [webmuxd-example](https://github.com/webmuxd/webmuxd-example) and it's
corresponding server component [go-webmuxd](https://github.com/webmuxd/go-webmuxd).  The example connects up this
component to a WebSocket and pipes the USB content back and forth to the `go-webmuxd` server, which finally passes
it to `libimobiledevice` via a UNIX socket on disk.

## Developing

The simplest way to build, develop and diagnose is using the `XHC20` USB capture on macOS, and optionally `demuxusb`

https://www.umpah.net/how-to-sniff-usb-traffic-reverse-engineer-usb-device-interactions/

### Building

If you wish to create your own build it's rather simple:
`yarn run build`

### Testing

Using a Chromebook as an endpoint:

https://blog.rickmark.me/puppeteer-with-chromeos/

## Contributing and License

This project is happy to accept PRs and other contributions.  It is free for commercial use under the MIT license, 
I would love to see it credited if so!

### Credits

`webmuxd` was initially written by Rick Mark

## Roadmap

To make this component "production ready" and less of a proof of concept the following should be completed:

* Handle all `usbmuxd` framing, and ACKs in script to reduce RTT (round trip time)
* Create a standardized WebSocket protocol and move it from `webmuxd-example` to `webmuxd` keeping only the UI
  * Move `MobileDevice.ts`
  * Move `RemoteChannel.ts`
  * Move `transport.proto` / `transport.ts`
* Factor out "common UI elements" to `webmuxd-ui`
  * Device Picker
  * Device Info
* Improve `go-webmuxd` as a multi-session "meet me" service
