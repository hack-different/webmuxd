
const USBMUX_USB_FILTER = [{ vendorId: 0x5ac, productId: 0x12a8 }];
const USBMUX_CLASS = 255;
const USBMUX_SUBCLASS = 254;
const USBMUX_PROTOCOL = 2;

type LogLevel = "debug" | "info" | "warn" | "error"

export interface Logger {
  log(level: LogLevel, message: string): void
}

export const NULL_LOGGER = {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  log: (level: LogLevel, message: string): void => {
    return
  }
}

export const CONSOLE_LOGGER = {
  log: (level: LogLevel, message: string): void => {
    switch (level) {
      case "info":
        // eslint-disable-next-line no-console
        console.log(message)
        break
      case "warn":
        // eslint-disable-next-line no-console
        console.warn(message)
        break
      case "error":
        // eslint-disable-next-line no-console
        console.error(message)
        break
      case "debug":
        // eslint-disable-next-line no-console
        console.debug(message)
        break
      default:
        // eslint-disable-next-line no-console
        console.error(`Unknown log level ${level}: ${message}`)
    }
  }
}

export default class MobileDevice {
  static logger: Logger = NULL_LOGGER

  usbDevice: USBDevice;
  usbConfiguration: USBConfiguration | null = null
  usbInterface: USBInterface | null = null

  private closing = false
  private readInterval: number | null = null

  usbInputEndpoint: USBEndpoint | null = null
  usbOutputEndpoint: USBEndpoint | null = null
  inputTransfer: Promise<USBInTransferResult> | null = null


  public handleData: ((data: ArrayBuffer) => void) | null = null

  constructor(device: USBDevice) {
    this.usbDevice = device;
  }

  static supported(): boolean {
    return 'usb' in window.navigator;
  }

  static async selectDevice(): Promise<MobileDevice> {
    const device = await navigator.usb.requestDevice({ filters: USBMUX_USB_FILTER });
    return new MobileDevice(device);
  }

  static async getDevices(): Promise<MobileDevice[]> {
    const devices = await navigator.usb.getDevices();

    return devices.map((device) => {
      return new MobileDevice(device);
    });
  }

  get name(): string {
    return this.usbDevice.productName as string;
  }

  get serialNumber(): string {
    return this.usbDevice.serialNumber as string;
  }

  async close(): Promise<void> {
    if (!this.closing && this.readInterval) {
      window.clearInterval(this.readInterval);
    }

    this.closing = true;

    if (this.usbDevice && this.usbDevice.opened) {
      if (this.usbInterface && this.usbInterface.claimed) {
        MobileDevice.logger.log("info", `Closing interface ${this.usbInterface.interfaceNumber} for ${this.usbDevice.serialNumber}`);
        await this.usbDevice.releaseInterface(this.usbInterface.interfaceNumber);
      }

      await this.usbDevice.selectConfiguration(1);

      try {
        MobileDevice.logger.log("info", `Resetting device ${this.usbDevice.serialNumber}`);
        await this.usbDevice.reset();
      } finally {
        MobileDevice.logger.log("info", `Closing device ${this.usbDevice.serialNumber}`);
        await this.usbDevice.close();

        MobileDevice.logger.log("info", `Closed ${this.serialNumber}`);
      }
    }
  }

  async open(): Promise<void> {
    try {
      for (const configuration of this.usbDevice.configurations) {
        for (const usbInterface of configuration.interfaces) {
          MobileDevice.logger.log("debug", `Interface ${usbInterface.interfaceNumber} (Claimed: ${usbInterface.claimed})`)
          for (const alternate of usbInterface.alternates) {
            MobileDevice.logger.log("debug", `\tAlternate ${alternate.alternateSetting} ${alternate.interfaceName} Class ${alternate.interfaceClass} Subclass ${alternate.interfaceSubclass} Protocol ${alternate.interfaceProtocol}`)

            if (
              alternate.interfaceClass === USBMUX_CLASS &&
              alternate.interfaceSubclass === USBMUX_SUBCLASS &&
              alternate.interfaceProtocol === USBMUX_PROTOCOL
            ) {
              this.usbInterface = usbInterface;
              this.usbConfiguration = configuration;
            }
          }
        }
      }

      if (this.usbConfiguration && this.usbInterface) {
        MobileDevice.logger.log("info", `Opening device ${this.usbDevice.serialNumber}`);
        await this.usbDevice.open();

        if (this.usbDevice.configuration?.configurationValue !== this.usbConfiguration.configurationValue) {
          MobileDevice.logger.log("info",
            `Selecting Configuration ${this.usbConfiguration.configurationValue} from ${this.usbDevice.configuration?.configurationValue}`,
          );
          await this.usbDevice.selectConfiguration(this.usbConfiguration.configurationValue);
        }

        MobileDevice.logger.log("info", `Claiming Interface ${this.usbInterface.interfaceNumber}`);
        await this.usbDevice.claimInterface(this.usbInterface.interfaceNumber);

        for (const endpoint of this.usbInterface.alternates[0].endpoints) {
          MobileDevice.logger.log("info", `Endpoint ${endpoint.endpointNumber} ${endpoint.direction}`);
          if (endpoint.direction === 'in') {
            this.usbInputEndpoint = endpoint;
          }
          if (endpoint.direction === 'out') {
            this.usbOutputEndpoint = endpoint;
          }
        }
      } else {
        MobileDevice.logger.log("error", `No configuration ${this.usbConfiguration} or interface ${this.usbInterface}`);
      }

      this.readInterval = window.setInterval(() => {
        this.deviceReader();
      }, 1000);
    } catch (e) {
      if (typeof e === 'string') {
        MobileDevice.logger.log("error", e);
      }
      else if (e instanceof Error) {
        MobileDevice.logger.log("error", e.message)
      }
    }
  }

  private deviceReader() {
    if (!this || !this.usbDevice || !this.usbDevice.opened || !this.usbInterface) {
      MobileDevice.logger.log("info", 'deviceReader not in ready state');
      return;
    }

    if (this.inputTransfer && !this.closing) {
      return;
    }

    MobileDevice.logger.log("info", 'MobileDevice deviceReader loop');
    if (this.usbInputEndpoint === null) {
      throw new Error('No input endpoint');
    }

    const inputEndpoint = this.usbInputEndpoint.endpointNumber;
    this.inputTransfer = this.usbDevice.transferIn(inputEndpoint, 4096);

    this.inputTransfer
      .then((result) => {
        MobileDevice.logger.log("info", `Received USB data ${result.data?.byteLength} status ${result.status}`);
        if (this.handleData && result.data) {
          this.handleData(result.data.buffer);
        }
        this.inputTransfer = null;
        this.deviceReader();
      })
      .catch((reason) => {
        MobileDevice.logger.log("error", `InputTransfer exception: ${reason}`);
      });
  }

  async sendData(data: ArrayBuffer): Promise<USBOutTransferResult | null> {
    const outputEndpoint = this.usbOutputEndpoint?.endpointNumber;

    if (outputEndpoint !== undefined) {
      MobileDevice.logger.log("info", `Outputting Data to Device on ${outputEndpoint}`);
      return await this.usbDevice.transferOut(outputEndpoint, data);
    } else {
      MobileDevice.logger.log("info", `Undefined output interface ${outputEndpoint}`);
    }

    return null;
  }
}
