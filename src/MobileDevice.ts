import { Logger, NULL_LOGGER } from './logger';
import UsbMux, { UsbMuxOptions } from './usbmux/UsbMux';

export const USBMUX_USB_FILTER: USBDeviceFilter[] = [{ vendorId: 0x5ac, productId: 0x12a8 }];
const USBMUX_CLASS = 255;
const USBMUX_SUBCLASS = 254;
const USBMUX_PROTOCOL = 2;

// usbmuxd reads in 16 KiB transfers; asking for more lets one transfer carry several packets.
const READ_TRANSFER_SIZE = 65536;
const DEFAULT_PACKET_SIZE = 512;

const usb = (): USB => {
  const usbApi = (globalThis.navigator as Navigator | undefined)?.usb;
  if (!usbApi) {
    throw new Error('WebUSB is not supported in this environment');
  }
  return usbApi;
};

/**
 * An Apple mobile device reached over WebUSB, exposing the raw usbmux bulk endpoints.
 *
 * Use `startMux()` to speak usbmux in the browser, or `handleData` / `sendData` to relay the raw byte stream
 * elsewhere (as `RemoteChannel` does in raw mode).
 */
export default class MobileDevice {
  static logger: Logger = NULL_LOGGER;

  usbDevice: USBDevice;
  usbConfiguration: USBConfiguration | null = null;
  usbInterface: USBInterface | null = null;

  usbInputEndpoint: USBEndpoint | null = null;
  usbOutputEndpoint: USBEndpoint | null = null;
  inputTransfer: Promise<USBInTransferResult> | null = null;

  public handleData: ((data: ArrayBuffer) => void) | null = null;
  public onReadError: ((error: Error) => void) | null = null;

  private closing = false;
  private reading = false;
  private muxSession: UsbMux | null = null;

  constructor(device: USBDevice) {
    this.usbDevice = device;
  }

  static supported(): boolean {
    return typeof globalThis.navigator !== 'undefined' && 'usb' in globalThis.navigator;
  }

  static async selectDevice(): Promise<MobileDevice> {
    const device = await usb().requestDevice({ filters: USBMUX_USB_FILTER });
    return new MobileDevice(device);
  }

  static async getDevices(): Promise<MobileDevice[]> {
    const devices = await usb().getDevices();

    return devices.map((device) => new MobileDevice(device));
  }

  get name(): string {
    return this.usbDevice.productName as string;
  }

  get serialNumber(): string {
    return this.usbDevice.serialNumber as string;
  }

  get opened(): boolean {
    return this.usbDevice.opened && this.usbInputEndpoint !== null && this.usbOutputEndpoint !== null;
  }

  get mux(): UsbMux | null {
    return this.muxSession;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.reading = false;

    if (this.muxSession) {
      this.muxSession.close();
      this.muxSession = null;
    }

    if (this.usbDevice && this.usbDevice.opened) {
      if (this.usbInterface && this.usbInterface.claimed) {
        MobileDevice.logger.log(
          'info',
          `Closing interface ${this.usbInterface.interfaceNumber} for ${this.usbDevice.serialNumber}`,
        );
        await this.usbDevice.releaseInterface(this.usbInterface.interfaceNumber);
      }

      await this.usbDevice.selectConfiguration(1);

      try {
        MobileDevice.logger.log('info', `Resetting device ${this.usbDevice.serialNumber}`);
        await this.usbDevice.reset();
      } finally {
        MobileDevice.logger.log('info', `Closing device ${this.usbDevice.serialNumber}`);
        await this.usbDevice.close();

        MobileDevice.logger.log('info', `Closed ${this.serialNumber}`);
      }
    }
  }

  async open(): Promise<void> {
    this.closing = false;
    this.findMuxInterface();

    if (!this.usbConfiguration || !this.usbInterface) {
      throw new Error(`Device ${this.usbDevice.serialNumber} has no usbmux interface`);
    }

    try {
      MobileDevice.logger.log('info', `Opening device ${this.usbDevice.serialNumber}`);
      await this.usbDevice.open();

      if (this.usbDevice.configuration?.configurationValue !== this.usbConfiguration.configurationValue) {
        MobileDevice.logger.log(
          'info',
          `Selecting Configuration ${this.usbConfiguration.configurationValue} from ${this.usbDevice.configuration?.configurationValue}`,
        );
        await this.usbDevice.selectConfiguration(this.usbConfiguration.configurationValue);
      }

      MobileDevice.logger.log('info', `Claiming Interface ${this.usbInterface.interfaceNumber}`);
      await this.usbDevice.claimInterface(this.usbInterface.interfaceNumber);

      const alternate = this.muxAlternate(this.usbInterface) ?? this.usbInterface.alternates[0];
      if (alternate.alternateSetting !== 0) {
        await this.usbDevice.selectAlternateInterface(this.usbInterface.interfaceNumber, alternate.alternateSetting);
      }

      for (const endpoint of alternate.endpoints) {
        MobileDevice.logger.log('info', `Endpoint ${endpoint.endpointNumber} ${endpoint.direction}`);
        if (endpoint.type !== undefined && endpoint.type !== 'bulk') {
          continue;
        }
        if (endpoint.direction === 'in') {
          this.usbInputEndpoint = endpoint;
        }
        if (endpoint.direction === 'out') {
          this.usbOutputEndpoint = endpoint;
        }
      }
    } catch (e) {
      MobileDevice.logger.log('error', describe(e));
      throw e;
    }

    if (!this.usbInputEndpoint || !this.usbOutputEndpoint) {
      throw new Error(`Device ${this.usbDevice.serialNumber} is missing usbmux bulk endpoints`);
    }

    void this.readLoop();
  }

  /**
   * Opens the device if needed and negotiates usbmux with it in the browser.
   *
   * @param options - logging and channel tuning
   * @returns the ready mux, on which `connect(port)` opens channels to device services
   */
  async startMux(options: UsbMuxOptions = {}): Promise<UsbMux> {
    if (this.muxSession) {
      await this.muxSession.start();
      return this.muxSession;
    }
    if (!this.opened) {
      await this.open();
    }

    const mux = new UsbMux((data) => this.sendData(data), { logger: MobileDevice.logger, ...options });
    this.muxSession = mux;
    this.handleData = (data) => mux.receive(new Uint8Array(data));
    await mux.start();

    return mux;
  }

  async sendData(data: ArrayBuffer | Uint8Array): Promise<USBOutTransferResult | null> {
    const outputEndpoint = this.usbOutputEndpoint;

    if (!outputEndpoint) {
      MobileDevice.logger.log('warn', 'No output endpoint, dropping data');
      return null;
    }

    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    MobileDevice.logger.log('debug', `Sending ${bytes.byteLength} bytes to endpoint ${outputEndpoint.endpointNumber}`);
    const result = await this.usbDevice.transferOut(outputEndpoint.endpointNumber, toBufferSource(bytes));

    // A transfer that is an exact multiple of the packet size needs a zero length packet to mark its end.
    const packetSize = outputEndpoint.packetSize || DEFAULT_PACKET_SIZE;
    if (bytes.byteLength > 0 && bytes.byteLength % packetSize === 0) {
      await this.usbDevice.transferOut(outputEndpoint.endpointNumber, new ArrayBuffer(0));
    }

    return result;
  }

  private async readLoop(): Promise<void> {
    if (this.reading) {
      return;
    }
    this.reading = true;

    while (this.reading && !this.closing && this.usbDevice.opened && this.usbInputEndpoint) {
      const endpoint = this.usbInputEndpoint.endpointNumber;
      try {
        this.inputTransfer = this.usbDevice.transferIn(endpoint, READ_TRANSFER_SIZE);
        const result = await this.inputTransfer;
        this.inputTransfer = null;

        if (result.status === 'stall') {
          MobileDevice.logger.log('warn', `Endpoint ${endpoint} stalled, clearing halt`);
          await this.usbDevice.clearHalt('in', endpoint);
          continue;
        }
        if (result.status === 'babble') {
          MobileDevice.logger.log('warn', `Endpoint ${endpoint} babble, dropping transfer`);
          continue;
        }

        if (result.data && result.data.byteLength > 0 && this.handleData) {
          const view = result.data;
          this.handleData(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer);
        }
      } catch (e) {
        this.inputTransfer = null;
        if (!this.closing) {
          MobileDevice.logger.log('error', `InputTransfer exception: ${describe(e)}`);
          if (this.onReadError) {
            this.onReadError(e instanceof Error ? e : new Error(describe(e)));
          }
        }
        break;
      }
    }

    this.reading = false;
  }

  private findMuxInterface(): void {
    for (const configuration of this.usbDevice.configurations) {
      for (const usbInterface of configuration.interfaces) {
        MobileDevice.logger.log(
          'debug',
          `Interface ${usbInterface.interfaceNumber} (Claimed: ${usbInterface.claimed})`,
        );
        if (this.muxAlternate(usbInterface)) {
          this.usbInterface = usbInterface;
          this.usbConfiguration = configuration;
          return;
        }
      }
    }
  }

  private muxAlternate(usbInterface: USBInterface): USBAlternateInterface | undefined {
    return usbInterface.alternates.find(
      (alternate) =>
        alternate.interfaceClass === USBMUX_CLASS &&
        alternate.interfaceSubclass === USBMUX_SUBCLASS &&
        alternate.interfaceProtocol === USBMUX_PROTOCOL,
    );
  }
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// WebUSB wants an ArrayBuffer-backed view; copy only when handed a SharedArrayBuffer-backed one.
const toBufferSource = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
  bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
