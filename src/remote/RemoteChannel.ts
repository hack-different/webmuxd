import { Logger, NULL_LOGGER } from '../logger';
import MobileDevice from '../MobileDevice';
import MuxPacketParser from '../usbmux/MuxPacketParser';
import TcpChannel from '../usbmux/TcpChannel';
import {
  ChannelData,
  ChannelState,
  ClientMessage,
  CloseChannel,
  DataToDevice,
  OpenChannel,
  ServerMessage,
} from './transport';

export type RemoteMode = 'raw' | 'mux';

// The subset of the browser WebSocket API RemoteChannel relies on, so another implementation can be supplied.
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}

export interface RemoteChannelOptions {
  // Defaults to wss://<current host>/v1/device, where go-webmuxd listens.
  url?: string;
  // Reopen the socket when it closes and announce bound devices again.
  reopen?: boolean;
  // raw relays usbmux packets for the server to decode; mux speaks usbmux here and relays channel bytes.
  mode?: RemoteMode;
  logger?: Logger;
  webSocketFactory?: (url: string) => WebSocketLike;
}

const WEBSOCKET_OPEN = 1;

interface BoundDevice {
  device: MobileDevice;
  channels: Map<number, TcpChannel>;
}

const defaultUrl = (): string => `wss://${globalThis.location?.host ?? 'localhost'}/v1/device`;

const defaultFactory = (url: string): WebSocketLike => new WebSocket(url) as unknown as WebSocketLike;

/**
 * Connects devices in this browser to a remote webmuxd server over a WebSocket.
 */
export default class RemoteChannel {
  readonly url: string;
  readonly mode: RemoteMode;
  socket: WebSocketLike;
  devices: { [serialNumber: string]: BoundDevice } = {};

  private readonly reopen: boolean;
  private readonly logger: Logger;
  private readonly factory: (url: string) => WebSocketLike;
  private openCallback: (() => void) | null = null;
  private outbox: Uint8Array[] = [];
  private closed = false;

  constructor(options: RemoteChannelOptions | boolean = {}) {
    // Older callers passed only the reopen flag.
    const resolved: RemoteChannelOptions = typeof options === 'boolean' ? { reopen: options } : options;

    this.url = resolved.url ?? defaultUrl();
    this.mode = resolved.mode ?? 'raw';
    this.reopen = resolved.reopen ?? false;
    this.logger = resolved.logger ?? NULL_LOGGER;
    this.factory = resolved.webSocketFactory ?? defaultFactory;
    this.socket = this.connectSocket();
  }

  get isOpen(): boolean {
    return this.socket.readyState === WEBSOCKET_OPEN;
  }

  onOpen(callback: () => void): void {
    this.openCallback = callback;
    if (this.isOpen) {
      callback();
    }
  }

  async bindDevice(device: MobileDevice): Promise<void> {
    const bound: BoundDevice = { device, channels: new Map() };
    this.devices[device.serialNumber] = bound;

    if (this.mode === 'mux') {
      await device.startMux();
    } else {
      if (!device.opened) {
        await device.open();
      }
      const parser = new MuxPacketParser();
      device.handleData = (data) => {
        let packets: Uint8Array[];
        try {
          packets = parser.push(new Uint8Array(data));
        } catch (e) {
          this.logger.log('error', `Raw relay for ${device.serialNumber}: ${e instanceof Error ? e.message : e}`);
          return;
        }
        // Forward whole mux packets only, so the server never has to reassemble a split one.
        for (const packet of packets) {
          this.sendMessage({
            message: { $case: 'fromDevice', value: { serialNumber: device.serialNumber, data: packet } },
          });
        }
      };
    }

    this.announce(device);
  }

  unbindDevice(device: MobileDevice): void {
    const bound = this.devices[device.serialNumber];
    if (!bound) {
      return;
    }
    bound.channels.forEach((channel) => channel.close());
    delete this.devices[device.serialNumber];
    if (this.mode === 'raw') {
      device.handleData = null;
    }
    this.sendMessage({
      message: { $case: 'deviceDisconnected', value: { serialNumber: device.serialNumber } },
    });
  }

  close(): void {
    this.closed = true;
    Object.values(this.devices).forEach((bound) => bound.channels.forEach((channel) => channel.close()));
    this.socket.close();
  }

  dataFromServer(data: ArrayBuffer | Uint8Array): void {
    let clientMessage: ClientMessage;
    try {
      clientMessage = ClientMessage.decode(data instanceof Uint8Array ? data : new Uint8Array(data));
    } catch (e) {
      this.logger.log('error', `Undecodable message from server: ${e instanceof Error ? e.message : e}`);
      return;
    }

    const message = clientMessage.message;
    switch (message?.$case) {
      case 'toDevice':
        this.handleToDevice(message.value);
        return;
      case 'openChannel':
        this.handleOpenChannel(message.value);
        return;
      case 'channelData':
        this.handleChannelData(message.value);
        return;
      case 'closeChannel':
        this.handleCloseChannel(message.value);
        return;
      default:
        this.logger.log('warn', 'Empty or unknown message from server');
    }
  }

  private handleToDevice(toDevice: DataToDevice): void {
    const bound = this.devices[toDevice.serialNumber];
    const correlationId = toDevice.correlationId;

    if (!bound) {
      this.logger.log('warn', `Data for unknown device ${toDevice.serialNumber}`);
      this.sendResult(correlationId, false);
      return;
    }

    bound.device.sendData(toDevice.data).then(
      (result) => this.sendResult(correlationId, result?.status === 'ok'),
      (e: unknown) => {
        this.logger.log('error', `Write to ${toDevice.serialNumber} failed: ${e instanceof Error ? e.message : e}`);
        this.sendResult(correlationId, false);
      },
    );
  }

  private handleOpenChannel(open: OpenChannel): void {
    const bound = this.devices[open.serialNumber];
    const mux = bound?.device.mux;

    if (!bound || !mux) {
      this.sendChannelState(open.serialNumber, open.channelId, ChannelState.CHANNEL_STATE_REFUSED, 'No such device');
      return;
    }

    mux.connect(open.port).then(
      (channel) => {
        bound.channels.set(open.channelId, channel);
        channel.onData = (data) =>
          this.sendMessage({
            message: {
              $case: 'channelData',
              value: { serialNumber: open.serialNumber, channelId: open.channelId, data },
            },
          });
        channel.onStateChange = (state) => {
          if (state === 'closed' || state === 'refused') {
            bound.channels.delete(open.channelId);
            this.sendChannelState(open.serialNumber, open.channelId, ChannelState.CHANNEL_STATE_CLOSED, state);
          }
        };
        this.sendChannelState(open.serialNumber, open.channelId, ChannelState.CHANNEL_STATE_CONNECTED, '');
      },
      (e: unknown) => {
        this.sendChannelState(
          open.serialNumber,
          open.channelId,
          ChannelState.CHANNEL_STATE_REFUSED,
          e instanceof Error ? e.message : String(e),
        );
      },
    );
  }

  private handleChannelData(data: ChannelData): void {
    const channel = this.devices[data.serialNumber]?.channels.get(data.channelId);
    if (!channel) {
      this.logger.log('warn', `Data for unknown channel ${data.channelId} on ${data.serialNumber}`);
      return;
    }
    try {
      channel.write(data.data);
    } catch (e) {
      this.logger.log('error', `Write to channel ${data.channelId} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private handleCloseChannel(close: CloseChannel): void {
    const bound = this.devices[close.serialNumber];
    const channel = bound?.channels.get(close.channelId);
    if (channel) {
      bound.channels.delete(close.channelId);
      channel.close();
    }
  }

  private announce(device: MobileDevice): void {
    this.sendMessage({
      message: {
        $case: 'deviceConnected',
        value: {
          serialNumber: device.serialNumber,
          vendorId: device.usbDevice.vendorId,
          productId: device.usbDevice.productId,
          productName: device.name ?? '',
          muxInClient: this.mode === 'mux',
        },
      },
    });
  }

  private sendResult(correlationId: string, success: boolean): void {
    this.sendMessage({ message: { $case: 'toDeviceResult', value: { correlationId, success } } });
  }

  private sendChannelState(serialNumber: string, channelId: number, state: ChannelState, reason: string): void {
    this.sendMessage({ message: { $case: 'channelState', value: { serialNumber, channelId, state, reason } } });
  }

  private sendMessage(message: ServerMessage): void {
    const data = ServerMessage.encode(message).finish();
    if (this.isOpen) {
      this.socket.send(data);
    } else {
      this.outbox.push(data);
    }
  }

  private connectSocket(): WebSocketLike {
    const socket = this.factory(this.url);
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
      this.logger.log('info', `RemoteChannel open to ${this.url}`);
      const queued = this.outbox;
      this.outbox = [];
      queued.forEach((data) => socket.send(data));
      if (this.openCallback) {
        this.openCallback();
      }
    };
    socket.onerror = (event) => {
      this.logger.log('error', `RemoteChannel error: ${String(event)}`);
    };
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer || event.data instanceof Uint8Array) {
        this.dataFromServer(event.data);
      } else {
        this.logger.log('warn', 'Ignoring non-binary message from server');
      }
    };
    socket.onclose = () => {
      if (this.closed || !this.reopen) {
        return;
      }
      this.logger.log('info', 'Reopening RemoteChannel after close');
      // Channels belonged to the old server session; the server will rediscover devices from the announcements.
      Object.values(this.devices).forEach((bound) => {
        bound.channels.forEach((channel) => {
          channel.onStateChange = null;
          channel.close();
        });
        bound.channels.clear();
      });
      this.socket = this.connectSocket();
      Object.values(this.devices).forEach((bound) => this.announce(bound.device));
    };

    return socket;
  }
}
