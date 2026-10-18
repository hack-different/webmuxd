import { FakeAppleDevice } from './fakeDevice';

/**
 * A WebUSB USBDevice backed by FakeAppleDevice: bulk OUT feeds the fake, bulk IN resolves with whatever the fake
 * sends back, one queued chunk per transfer.
 */
export class FakeUsbDevice {
  readonly vendorId = 0x5ac;
  readonly productId = 0x12a8;
  readonly productName = 'iPhone';
  readonly serialNumber = '00008030-000000000000002E';
  opened = false;
  configuration: { configurationValue: number } | null = { configurationValue: 1 };
  readonly outTransfers: Uint8Array[] = [];
  readonly apple = new FakeAppleDevice();
  readonly calls: string[] = [];
  // Split device replies into transfers of at most this many bytes, to exercise reassembly.
  inChunkSize = Infinity;

  readonly muxInterface = {
    interfaceNumber: 1,
    claimed: false,
    alternates: [
      {
        alternateSetting: 0,
        interfaceClass: 255,
        interfaceSubclass: 254,
        interfaceProtocol: 2,
        interfaceName: 'usbmux',
        endpoints: [
          { endpointNumber: 4, direction: 'out', type: 'bulk', packetSize: 512 },
          { endpointNumber: 5, direction: 'in', type: 'bulk', packetSize: 512 },
        ],
      },
    ],
  };

  readonly configurations = [
    { configurationValue: 1, interfaces: [] as unknown[] },
    {
      configurationValue: 4,
      interfaces: [
        {
          interfaceNumber: 0,
          claimed: false,
          alternates: [
            { alternateSetting: 0, interfaceClass: 1, interfaceSubclass: 1, interfaceProtocol: 0, endpoints: [] },
          ],
        },
        this.muxInterface,
      ],
    },
  ];

  private inbox: Uint8Array[] = [];
  private waiting: ((result: USBInTransferResult) => void) | null = null;

  constructor() {
    this.apple.toHost = (data) => {
      for (let offset = 0; offset < data.byteLength; offset += this.inChunkSize) {
        this.deliver(data.slice(offset, Math.min(data.byteLength, offset + this.inChunkSize)));
      }
    };
  }

  deliver(data: Uint8Array): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({
        data: new DataView(data.buffer, data.byteOffset, data.byteLength),
        status: 'ok',
      } as USBInTransferResult);
    } else {
      this.inbox.push(data);
    }
  }

  async open(): Promise<void> {
    this.calls.push('open');
    this.opened = true;
  }

  async close(): Promise<void> {
    this.calls.push('close');
    this.opened = false;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ status: 'ok' } as USBInTransferResult);
    }
  }

  async selectConfiguration(value: number): Promise<void> {
    this.calls.push(`selectConfiguration ${value}`);
    this.configuration = { configurationValue: value };
  }

  async claimInterface(n: number): Promise<void> {
    this.calls.push(`claimInterface ${n}`);
    this.muxInterface.claimed = true;
  }

  async releaseInterface(n: number): Promise<void> {
    this.calls.push(`releaseInterface ${n}`);
    this.muxInterface.claimed = false;
  }

  async selectAlternateInterface(): Promise<void> {
    this.calls.push('selectAlternateInterface');
  }

  async reset(): Promise<void> {
    this.calls.push('reset');
  }

  async clearHalt(): Promise<void> {
    this.calls.push('clearHalt');
  }

  async transferOut(endpoint: number, data: BufferSource): Promise<USBOutTransferResult> {
    const view =
      data instanceof ArrayBuffer
        ? new Uint8Array(data).slice()
        : new Uint8Array(
            (data as Uint8Array).buffer,
            (data as Uint8Array).byteOffset,
            (data as Uint8Array).byteLength,
          ).slice();
    this.outTransfers.push(view);
    if (view.byteLength > 0) this.apple.fromHost(view);
    return { bytesWritten: view.byteLength, status: 'ok' } as USBOutTransferResult;
  }

  transferIn(): Promise<USBInTransferResult> {
    const next = this.inbox.shift();
    if (next) {
      return Promise.resolve({
        data: new DataView(next.buffer, next.byteOffset, next.byteLength),
        status: 'ok',
      } as USBInTransferResult);
    }
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  asUsbDevice(): USBDevice {
    return this as unknown as USBDevice;
  }
}
