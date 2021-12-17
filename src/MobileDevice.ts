// eslint-disable-next-line max-classes-per-file
import { Logger, NULL_LOGGER } from './Logger'
import { Parser } from 'binary-parser'

const USB_VID_APPLE = 0x5AC
const USB_PID_USBMUXD_DEVICE = 0x12A8
const USB_MUX_USB_FILTER = [{ vendorId: USB_VID_APPLE, productId: USB_PID_USBMUXD_DEVICE }];
const USB_MUX_CLASS = 255;
const USB_MUX_SUBCLASS = 254;
const USB_MUX_PROTOCOL = 2;

const DEV_MRU = 65536
const CONN_INPUT_BUF_SIZE	= 262144
const CONN_OUTPUT_BUF_SIZE=	65536
const ACK_TIMEOUT = 30

const HOST_TO_DEVICE_MAGIC = 0xfeedface
const DEVICE_TO_HOST_MAGIC = 0xfacefeed

enum USBMuxProtocol {
  version = 0,
  control = 1,
  setup = 2,
  tcp = 6,
}

enum USBMuxConectionState {
  connecting,	// SYN
  connected,		// SYN/SYN-ACK/ACK -> active
  refused,		  // RST received during SYN
  dying,			  // RST received
  dead			    // being freed; used to prevent infinite recursion between client<->device freeing
}

const USBMUX_HEADER = (new Parser().
  endianess('big').
  uint32('protocol').
  uint32('length').
  uint32('magic').
  uint16('tx_seq').
  uint16('rx_seq')
)

const VERSION_HEADER = (new Parser().
  endianess('big').
  uint32('major').
  uint32('minor').
  uint32('padding')
)

enum TCPFlags {
  fin = 1,
  syn = 2,
  rst = 4,
  push = 8,
  ack = 0x10,
  urg = 0x20,
  ece = 0x40,
  cwr = 0x80,
}

const TCP_HEADER = (new Parser().
  endianess('big').
  uint16('sport').
  uint16('dport').
  uint32('sequence').
  uint32('ack').
  bit4('unused').
  bit4('offset').
  uint8('flags').
  uint16('window').
  uint16('checksum').
  uint16('urgent')
)

class USBTCPFrame {

}

class ServiceConnection {

  private readonly currentFrame: USBTCPFrame | null
  readonly port: number

  constructor(port: number) {
    this.port = port
    this.currentFrame = null
  }

  async close(): Promise<null> {
    return new Promise(() => { return })
  }
}


export default class MobileDevice {

  static logger: Logger = NULL_LOGGER;

  usbDevice: USBDevice;
  usbConfiguration: USBConfiguration | null = null;
  usbInterface: USBInterface | null = null;

  private closing = false;
  private readInterval: number | null = null;
  private connections: ServiceConnection[] = []

  usbInputEndpoint: USBEndpoint | null = null;
  usbOutputEndpoint: USBEndpoint | null = null;
  inputTransfer: Promise<USBInTransferResult> | null = null;

  public handleData: ((data: ArrayBuffer) => void) | null = null;

  constructor(device: USBDevice) {
    this.usbDevice = device;
  }

  static supported(): boolean {
    return 'usb' in window.navigator;
  }

  static async selectDevice(): Promise<MobileDevice> {
    const device = await navigator.usb.requestDevice({ filters: USB_MUX_USB_FILTER });
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

  async openConnection(port: number): Promise<ServiceConnection> {
    // eslint-disable-next-line eqeqeq
    if (parseInt(String(port), 10) != parseFloat(String(port))) {
      throw Error("Port must be an Integer")
    }
    
    return new Promise<ServiceConnection>(() => { new ServiceConnection(port) })
  }

  async close(): Promise<void> {
    if (!this.closing && this.readInterval) {
      window.clearInterval(this.readInterval);
    }

    this.closing = true;

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
    try {
      for (const configuration of this.usbDevice.configurations) {
        for (const usbInterface of configuration.interfaces) {
          MobileDevice.logger.log(
            'debug',
            `Interface ${usbInterface.interfaceNumber} (Claimed: ${usbInterface.claimed})`,
          );
          for (const alternate of usbInterface.alternates) {
            MobileDevice.logger.log(
              'debug',
              `\tAlternate ${alternate.alternateSetting} ${alternate.interfaceName} Class ${alternate.interfaceClass} Subclass ${alternate.interfaceSubclass} Protocol ${alternate.interfaceProtocol}`,
            );

            if (
              alternate.interfaceClass === USB_MUX_CLASS &&
              alternate.interfaceSubclass === USB_MUX_SUBCLASS &&
              alternate.interfaceProtocol === USB_MUX_PROTOCOL
            ) {
              this.usbInterface = usbInterface;
              this.usbConfiguration = configuration;
            }
          }
        }
      }

      if (this.usbConfiguration && this.usbInterface) {
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

        for (const endpoint of this.usbInterface.alternates[0].endpoints) {
          MobileDevice.logger.log('info', `Endpoint ${endpoint.endpointNumber} ${endpoint.direction}`);
          if (endpoint.direction === 'in') {
            this.usbInputEndpoint = endpoint;
          }
          if (endpoint.direction === 'out') {
            this.usbOutputEndpoint = endpoint;
          }
        }
      } else {
        MobileDevice.logger.log('error', `No configuration ${this.usbConfiguration} or interface ${this.usbInterface}`);
      }

      this.readInterval = window.setInterval(() => {
        this.deviceReader();
      }, 1000);
    } catch (e) {
      if (typeof e === 'string') {
        MobileDevice.logger.log('error', e);
      } else if (e instanceof Error) {
        MobileDevice.logger.log('error', e.message);
      }
    }
  }

  private deviceReader() {
    if (!this || !this.usbDevice || !this.usbDevice.opened || !this.usbInterface) {
      MobileDevice.logger.log('info', 'deviceReader not in ready state');
      return;
    }

    if (this.inputTransfer && !this.closing) {
      return;
    }

    MobileDevice.logger.log('info', 'MobileDevice deviceReader loop');
    if (this.usbInputEndpoint === null) {
      throw new Error('No input endpoint');
    }

    const inputEndpoint = this.usbInputEndpoint.endpointNumber;
    this.inputTransfer = this.usbDevice.transferIn(inputEndpoint, 4096);

    this.inputTransfer
      .then((result) => {
        MobileDevice.logger.log('info', `Received USB data ${result.data?.byteLength} status ${result.status}`);
        if (this.handleData && result.data) {
          this.handleData(result.data.buffer);
        }
        this.inputTransfer = null;
        this.deviceReader();
      })
      .catch((reason) => {
        MobileDevice.logger.log('error', `InputTransfer exception: ${reason}`);
      });
  }

  async sendData(data: ArrayBuffer): Promise<USBOutTransferResult | null> {
    const outputEndpoint = this.usbOutputEndpoint?.endpointNumber;

    if (outputEndpoint !== undefined) {
      MobileDevice.logger.log('info', `Outputting Data to Device on ${outputEndpoint}`);
      return await this.usbDevice.transferOut(outputEndpoint, data);
    } else {
      MobileDevice.logger.log('info', `Undefined output interface ${outputEndpoint}`);
    }

    return null;
  }
}
