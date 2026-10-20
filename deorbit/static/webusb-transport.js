// webusb-transport.js - low-level WebUSB bulk transport.
//
// Publishable: contains no exploit logic, just device open/claim and
// bulk IN/OUT transfers with PTP-style zero-length-packet (ZLP) handling.

export const USB_DEFAULTS = {
  vid: 0x1d6b,
  pid: 0x0100,
  epOut: 0x01, // bEndpointAddress
  epIn: 0x81, // bEndpointAddress (IN bit set)
  iface: 0,
  config: 1,
  packetSize: 512,
};

// WebUSB transferIn/transferOut take the endpoint NUMBER (0-15), not the
// bEndpointAddress - passing 0x81 throws "endpoint number is out of range".
const epNum = (addr) => addr & 0x0f;

/** A 16-bit value as four lowercase hex digits, for log messages. */
export const hex4 = (v) => v.toString(16).padStart(4, "0");

export class USBTransportError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "USBTransportError";
  }
}

export class USBTimeoutError extends USBTransportError {
  constructor(msg = "transfer timed out") {
    super(msg);
    this.name = "USBTimeoutError";
  }
}

export class WebUSBTransport {
  /** @param opts USB_DEFAULTS overrides, plus an optional log(message). */
  constructor(opts = {}) {
    const { log, ...cfg } = opts;
    this.cfg = { ...USB_DEFAULTS, ...cfg };
    this.log = log ?? (() => {});
    this.device = null;
  }

  static isSupported() {
    return typeof navigator !== "undefined" && !!navigator.usb;
  }

  /**
   * Request, open and claim the device.
   * MUST be called from a user gesture (requestDevice requirement).
   * `doReset` is best-effort: USBDevice.reset() is only implemented on
   * Linux; elsewhere it throws and is ignored.
   */
  async open({ doReset = false } = {}) {
    if (!WebUSBTransport.isSupported()) {
      throw new USBTransportError("WebUSB not supported (use Chrome/Edge, HTTPS or localhost)");
    }
    const c = this.cfg;
    const dev = await navigator.usb.requestDevice({
      filters: [{ vendorId: c.vid, productId: c.pid }],
    });
    this.device = dev;
    if (!dev.opened) await dev.open();
    if (doReset && dev.reset) {
      try {
        await dev.reset();
      } catch {
        /* unsupported on this platform - ignore */
      }
    }
    if (dev.configuration === null || dev.configuration.configurationValue !== c.config) {
      await dev.selectConfiguration(c.config);
    }
    await dev.claimInterface(c.iface);
    this.log(
      `usb: opened ${dev.productName || "device"} (${hex4(c.vid)}:${hex4(c.pid)}), ` +
        `claimed interface ${c.iface}`
    );
    return dev;
  }

  async close() {
    this._in = null;
    if (!this.device) return;
    try {
      await this.device.releaseInterface(this.cfg.iface);
    } catch {
      /* already released */
    }
    try {
      await this.device.close();
    } catch {
      /* already closed */
    }
    this.device = null;
    this.log("usb: closed");
  }

  /** Bulk OUT write; appends a ZLP when the payload is an exact multiple of
   * the packet size (short-write terminates exact multiples).
   * The timeout only REPORTS a stalled endpoint - if it fires, the pending
   * transfer may still land later, so the session must be aborted. */
  async write(data, timeoutMs = 10000) {
    let timer;
    const res = await Promise.race([
      this.device.transferOut(epNum(this.cfg.epOut), data),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new USBTimeoutError("transferOut timed out")), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if (res.status !== "ok") throw new USBTransportError(`transferOut status ${res.status}`);
    if (data.length && data.length % this.cfg.packetSize === 0) {
      try {
        await this.device.transferOut(epNum(this.cfg.epOut), new ArrayBuffer(0));
      } catch {
        /* ZLP best-effort, same as the python client */
      }
    }
    return res.bytesWritten;
  }

  /**
   * Bulk IN read. WebUSB has no transfer timeout and no cancel, so the
   * timeout is emulated with a timer race - but the still-pending transfer
   * is KEPT and reused by the next read() call. Abandoning it would let it
   * silently consume the next bytes the device sends, leaving the protocol
   * one response behind forever (this is how drain/recovery paths used to
   * wedge the session handshake).
   */
  async read(size, timeoutMs = 10000) {
    if (!this._in) {
      this._in = this.device.transferIn(epNum(this.cfg.epIn), size);
      this._in.catch(() => {}); // rejection surfaces via race/future reads
    }
    const pending = this._in;
    let timer;
    try {
      const res = await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new USBTimeoutError()), timeoutMs);
        }),
      ]);
      this._in = null;
      if (res.status !== "ok") throw new USBTransportError(`transferIn status ${res.status}`);
      return new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
    } catch (e) {
      if (!(e instanceof USBTimeoutError)) this._in = null; // transfer died
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Concatenate Uint8Arrays. */
export function concatBytes(arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
