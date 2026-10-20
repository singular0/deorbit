// mtp-client.js - raw PTP/MTP client: container framing, transactions,
// sessions and STANDARD object operations.
//
// Publishable: everything here is bog-standard MTP (PIMA 15740 / MTP 1.1)
// as spoken by any MTP responder. No exploit logic lives in this file.

import { concatBytes, hex4 } from "./webusb-transport.js";

export { hex4 };

export const STORAGE_ID = 0xffff0001;
export const MAX_CONTAINER = 64 * 1024 * 1024;

export const CT = { COMMAND: 1, DATA: 2, RESPONSE: 3 };

export const OP = {
  OPEN_SESSION: 0x1002,
  CLOSE_SESSION: 0x1003,
  GET_OBJ_HANDLES: 0x1007,
  GET_OBJ_INFO: 0x1008,
  GET_OBJECT: 0x1009,
  DELETE_OBJECT: 0x100b,
  SEND_OBJ_INFO: 0x100c,
  SEND_OBJECT: 0x100d,
  SET_OBJECT_PROP_VALUE: 0x9804,
  GET_PARTIAL_OBJECT_64: 0x95c1,
  SEND_PARTIAL_OBJECT: 0x95c2,
};

export const PROP = { OBJECT_FILE_NAME: 0xdc07 };

export const RESP = {
  OK: 0x2001,
  INCOMPLETE: 0x2007,
  INVALID_HANDLE: 0x2009,
};

export const MTP_FORMAT_ASSOCIATION = 0x3001; // directory
export const MTP_FORMAT_UNDEFINED = 0x3000;

export class MtpError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "MtpError";
  }
}

/** Growable little-endian byte writer (struct.pack replacement). */
export class BinWriter {
  constructor() {
    this.chunks = [];
    this.len = 0;
  }
  push(b) {
    this.chunks.push(b);
    this.len += b.length;
  }
  u8(v) {
    this.push(Uint8Array.of(v & 0xff));
  }
  u16(v) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    this.push(b);
  }
  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.push(b);
  }
  bytes(b) {
    this.push(b);
  }
  toBytes() {
    return concatBytes(this.chunks);
  }
}

export function encodeUtf16le(s) {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[2 * i] = c & 0xff;
    b[2 * i + 1] = c >> 8;
  }
  return b;
}

/** PTP string: u8 char count (incl. terminator) + UTF-16LE + NUL. */
export function ptpString(s) {
  const w = new BinWriter();
  w.u8(s.length + 1);
  w.bytes(encodeUtf16le(s));
  w.u16(0);
  return w.toBytes();
}

/** Pack a PTP container (header + payload). */
export function packContainer(ctype, code, txid, payload = new Uint8Array(0)) {
  const w = new BinWriter();
  w.u32(12 + payload.length);
  w.u16(ctype);
  w.u16(code);
  w.u32(txid);
  w.bytes(payload);
  return w.toBytes();
}

export function packParams(params) {
  const w = new BinWriter();
  for (const p of params) w.u32(p);
  return w.toBytes();
}

export function unpackParams(payload) {
  const n = Math.floor(payload.length / 4);
  if (!n) return [];
  const dv = new DataView(payload.buffer, payload.byteOffset, n * 4);
  const out = [];
  for (let i = 0; i < n; i++) out.push(dv.getUint32(i * 4, true));
  return out;
}

/** ObjectInfo dataset for SendObjectInfo. */
export function buildObjectInfo(name, size, storage = STORAGE_ID) {
  const w = new BinWriter();
  w.u32(storage); // StorageID
  w.u16(MTP_FORMAT_UNDEFINED); // ObjectFormat
  w.u16(0); // ProtectionStatus
  w.u32(size); // ObjectCompressedSize
  w.u16(0); // ThumbFormat
  for (let i = 0; i < 7; i++) w.u32(0); // thumb/image fields, bit depth, ParentObject
  w.u16(0); // AssociationType
  w.u32(0); // AssociationDesc
  w.u32(0); // SequenceNumber
  w.bytes(ptpString(name)); // Filename
  w.u8(0); // CaptureDate (empty)
  w.u8(0); // ModificationDate (empty)
  w.u8(0); // Keywords (empty)
  return w.toBytes();
}

export class MtpClient {
  /** @param transport object with async write(Uint8Array) / read(size, timeoutMs). */
  constructor(transport, options = {}) {
    this.t = transport;
    this.log = options.log ?? (() => {});
    this.tx = 0;
    this.session = 0;
  }

  async _readContainer(timeoutMs = 10000) {
    const first = await this.t.read(512, timeoutMs);
    if (first.length < 12) {
      throw new MtpError(`short read: ${first.length} bytes`);
    }
    const dv = new DataView(first.buffer, first.byteOffset, first.byteLength);
    const length = dv.getUint32(0, true);
    const ctype = dv.getUint16(4, true);
    const code = dv.getUint16(6, true);
    const txid = dv.getUint32(8, true);
    if (length < 12 || length > MAX_CONTAINER) {
      throw new MtpError(
        `bad container header: len=${length} type=${ctype} code=0x${code.toString(16)}`
      );
    }
    const parts = [first];
    let have = first.length;
    while (have < length) {
      const chunk = await this.t.read(512, timeoutMs);
      parts.push(chunk);
      have += chunk.length;
    }
    const data = concatBytes(parts).subarray(0, length);
    if (length % 512 === 0) {
      try {
        await this.t.read(512, 500); // consume the expected ZLP
      } catch {
        /* optional */
      }
    }
    return { ctype, code, txid, payload: data.subarray(12) };
  }

  _sendCommand(code, params = []) {
    this.tx += 1;
    const payload = packParams(params);
    const bytes = packContainer(CT.COMMAND, code, this.tx, payload);
    return this.t.write(bytes).then(() => this.tx);
  }

  /** Command -> optional data out -> response. Returns {code, params}. */
  async transOut(code, params = [], dataOut = null) {
    const txid = await this._sendCommand(code, params);
    if (dataOut !== null) {
      await this.t.write(packContainer(CT.DATA, code, txid, dataOut));
    }
    let r = await this._readContainer();
    while (r.ctype === CT.DATA) r = await this._readContainer();
    if (r.ctype !== CT.RESPONSE) {
      throw new MtpError(`expected response, got type ${r.ctype}`);
    }
    return { code: r.code, params: unpackParams(r.payload) };
  }

  /** Command -> data in -> response. Returns {code, data, params}. */
  async transIn(code, params = []) {
    await this._sendCommand(code, params);
    const bufs = [];
    let r = await this._readContainer();
    while (r.ctype === CT.DATA) {
      bufs.push(r.payload);
      r = await this._readContainer();
    }
    if (r.ctype !== CT.RESPONSE) {
      throw new MtpError(`expected response, got type ${r.ctype}`);
    }
    return { code: r.code, data: concatBytes(bufs), params: unpackParams(r.payload) };
  }

  // Sessions.

  async openSession(sid = null) {
    sid = sid || Math.floor(Date.now() / 1000) % 0x7fffffff || 1;
    this.log(`session: OpenSession (id ${sid}) ...`);
    const { code } = await this.transOut(OP.OPEN_SESSION, [sid]);
    this.session = sid;
    return code;
  }

  async closeSession() {
    return (await this.transOut(OP.CLOSE_SESSION, [])).code;
  }

  async drainIn(timeoutMs = 500, maxReads = 16) {
    let n = 0;
    try {
      for (; n < maxReads; n++) await this.t.read(512, timeoutMs);
    } catch {
      /* drained */
    }
    if (n) this.log(`session: drained ${n} stale packet(s)`);
  }

  /** Pre-session wedge workaround: CloseSession takes no parameters. */
  async bestEffortClose() {
    try {
      await this.drainIn();
      const { code } = await this.transOut(OP.CLOSE_SESSION, []);
      this.log(`session: pre-session CloseSession -> 0x${hex4(code)}`);
    } catch (e) {
      this.log(`session: pre-session CloseSession failed: ${e.message} (ok if the device was idle)`);
    }
  }

  // Standard object helpers.

  async listHandles(parent = 0, storage = STORAGE_ID) {
    const { code, data } = await this.transIn(OP.GET_OBJ_HANDLES, [storage, 0, parent]);
    if (code !== RESP.OK || data.length < 4) return { code, handles: [] };
    const count = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
    return { code, handles: unpackParams(data.subarray(4, 4 + count * 4)) };
  }

  async getObjectInfo(handle) {
    const { code, data } = await this.transIn(OP.GET_OBJ_INFO, [handle]);
    if (code !== RESP.OK || data.length < 53) return { code, info: null };
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const storage = dv.getUint32(0, true);
    const format = dv.getUint16(4, true);
    const size = dv.getUint32(8, true);
    const nchars = data[52]; // filename PTP-string starts at offset 52
    let name = new TextDecoder("utf-16le").decode(data.subarray(53, 53 + nchars * 2));
    return { code, info: { storage, format, size, name: name.replace(/\0+$/, "") } };
  }

  async getObject(handle) {
    return this.transIn(OP.GET_OBJECT, [handle]);
  }

  async deleteObject(handle) {
    return (await this.transOut(OP.DELETE_OBJECT, [handle, 0])).code;
  }

  /** Create an empty object; returns the new handle or null. */
  async sendObjectInfo(name, size, storage = STORAGE_ID, parent = 0) {
    const { code, params } = await this.transOut(
      OP.SEND_OBJ_INFO,
      [storage, parent],
      buildObjectInfo(name, size, storage)
    );
    if (code !== RESP.OK || !params.length) return null;
    return params[params.length - 1]; // last response param is the new handle
  }

  async sendObjectData(payload) {
    return this.transOut(OP.SEND_OBJECT, [], payload);
  }
}
