export class RtuError extends Error {
  constructor(message, kind = 'protocol', exceptionCode) {
    super(message);
    this.name = 'RtuError';
    this.kind = kind;
    this.exceptionCode = exceptionCode;
  }
}

export function crc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc;
}

function validate({ unitId, functionCode, address, count }) {
  if (!Number.isInteger(unitId) || unitId < 1 || unitId > 247) throw new RtuError('Unit ID ต้องอยู่ระหว่าง 1–247', 'input');
  if (![1, 2, 3, 4].includes(functionCode)) throw new RtuError('Function code ไม่ถูกต้อง', 'input');
  const max = functionCode <= 2 ? 2000 : 125;
  if (!Number.isInteger(address) || address < 0 || address > 65535 || !Number.isInteger(count) || count < 1 || count > max || address + count > 65536) throw new RtuError('ช่วง address หรือจำนวนค่าไม่ถูกต้อง', 'input');
}

export function buildRtuRequest(options) {
  validate(options);
  const { unitId, functionCode, address, count } = options;
  const frame = Uint8Array.from([unitId, functionCode, address >> 8, address & 255, count >> 8, count & 255, 0, 0]);
  const crc = crc16(frame.subarray(0, 6));
  frame[6] = crc & 255;
  frame[7] = crc >> 8;
  return frame;
}

export function parseRtuResponse(frame, { unitId, functionCode, count }) {
  if (frame.length < 5) throw new RtuError('RTU response สั้นเกินไป');
  if (frame[0] !== unitId) throw new RtuError('Unit ID ไม่ตรงกัน');
  const expected = frame[1] === (functionCode | 0x80) ? 5 : 5 + frame[2];
  if (frame.length !== expected) throw new RtuError('ความยาว RTU response ไม่ถูกต้อง');
  const crc = crc16(frame.subarray(0, -2));
  if (frame.at(-2) !== (crc & 255) || frame.at(-1) !== (crc >> 8)) throw new RtuError('RTU CRC ไม่ถูกต้อง');
  if (frame[1] === (functionCode | 0x80)) throw new RtuError(`Modbus exception ${frame[2]}`, 'exception', frame[2]);
  if (frame[1] !== functionCode) throw new RtuError('Function code ไม่ตรงกัน');
  const data = frame.subarray(3, -2);
  const byteCount = functionCode <= 2 ? Math.ceil(count / 8) : count * 2;
  if (data.length !== byteCount) throw new RtuError('จำนวน byte ไม่ตรงกับที่ขอ');
  if (functionCode <= 2) return Array.from({ length: count }, (_, i) => (data[i >> 3] >> (i & 7)) & 1);
  return Array.from({ length: count }, (_, i) => (data[i * 2] << 8) | data[i * 2 + 1]);
}

export class RtuClient {
  constructor(port) {
    this.port = port;
    this.opened = false;
    this.busy = false;
    this.reader = null;
    this.writer = null;
    this.activeController = null;
    this.desynced = false;
  }

  async open(settings) {
    if (this.opened) return;
    await this.port.open(settings);
    this.opened = true;
    this.desynced = false;
  }

  async read(options) {
    if (!this.opened) throw new RtuError('ยังไม่ได้เชื่อมต่อ Serial', 'transport');
    if (this.desynced) {
      const error = new RtuError('RTU ไม่ตรงเฟรม ต้องเชื่อมต่อใหม่ก่อนอ่านต่อ', 'transport');
      error.terminal = true;
      throw error;
    }
    if (this.busy) throw new RtuError('มีคำขอที่ยังไม่เสร็จ', 'transport');
    const request = buildRtuRequest(options);
    const timeoutMs = options.timeoutMs ?? 1500;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new RtuError('Timeout ต้องอยู่ระหว่าง 100–30000 ms', 'input');
    this.busy = true;
    const controller = new AbortController();
    this.activeController = controller;
    const externalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const deadline = Date.now() + timeoutMs;
    let bytes = [];
    let reader;
    let frameComplete = false;
    let failure;
    const guarded = async operation => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new RtuError('RTU timeout', 'transport');
      let timer;
      let onAbort;
      try {
        return await Promise.race([
          operation,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new RtuError('RTU timeout', 'transport')), remaining); }),
          new Promise((_, reject) => { onAbort = () => reject(new RtuError('RTU cancelled', 'cancelled')); controller.signal.addEventListener('abort', onAbort, { once: true }); if (controller.signal.aborted) onAbort(); })
        ]);
      } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); }
    };
    try {
      const writer = this.port.writable.getWriter();
      this.writer = writer;
      await guarded(writer.write(request));
      writer.releaseLock();
      this.writer = null;
      reader = this.port.readable.getReader();
      this.reader = reader;
      while (true) {
        const chunk = await guarded(reader.read());
        if (chunk.done) throw new RtuError('Serial ถูกตัดการเชื่อมต่อ', 'transport');
        bytes.push(...chunk.value);
        if (bytes.length > 260) throw new RtuError('RTU response ยาวเกินไป');
        if (bytes.length >= 3) {
          const expected = bytes[1] === (options.functionCode | 0x80) ? 5 : 5 + bytes[2];
          if (bytes.length >= expected) {
            if (bytes.length !== expected) throw new RtuError('มีข้อมูลเกิน RTU response');
            frameComplete = true;
            return parseRtuResponse(Uint8Array.from(bytes), options);
          }
        }
      }
    } catch (error) {
      failure = error;
      if (error?.kind !== 'exception') {
        this.desynced = true;
        error.terminal = true;
      }
      throw error;
    } finally {
      if (reader && !frameComplete) reader.cancel().catch(() => {});
      try { reader?.releaseLock(); } catch { /* a pending read may still hold the lock */ }
      if (this.writer) {
        if (failure) this.writer.abort?.().catch(() => {});
        try { this.writer.releaseLock(); } catch { /* pending write */ }
      }
      this.writer = null;
      this.reader = null;
      this.activeController = null;
      options.signal?.removeEventListener('abort', externalAbort);
      this.busy = false;
    }
  }

  async close() {
    if (!this.opened) return;
    this.activeController?.abort();
    if (this.reader) this.reader.cancel().catch(() => {});
    if (this.writer) this.writer.abort?.().catch(() => {});
    const limit = async promise => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new RtuError('ปิด Serial ไม่สำเร็จภายในเวลาที่กำหนด', 'transport')), 700); })]); }
      finally { clearTimeout(timer); }
    };
    try {
      await limit((async () => { while (this.busy) await new Promise(resolve => setTimeout(resolve, 10)); })());
      await limit(this.port.close());
    } finally { this.opened = false; this.desynced = true; }
  }
}
