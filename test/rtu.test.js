import test from 'node:test';
import assert from 'node:assert/strict';
import { crc16, buildRtuRequest, parseRtuResponse, RtuClient } from '../web/rtu.js';

test('builds RTU request with standard CRC', () => {
  assert.equal(crc16(Uint8Array.from([1, 3, 0, 0, 0, 1])), 0x0a84);
  assert.deepEqual([...buildRtuRequest({ unitId: 1, functionCode: 3, address: 0, count: 1 })], [1, 3, 0, 0, 0, 1, 0x84, 0x0a]);
});

test('parses register response and rejects bad CRC', () => {
  const body = Uint8Array.from([1, 3, 2, 0x12, 0x34]);
  const crc = crc16(body);
  const frame = Uint8Array.from([...body, crc & 255, crc >> 8]);
  assert.deepEqual(parseRtuResponse(frame, { unitId: 1, functionCode: 3, count: 1 }), [0x1234]);
  frame[5] ^= 1;
  assert.throws(() => parseRtuResponse(frame, { unitId: 1, functionCode: 3, count: 1 }), /CRC/);
});

test('classifies RTU illegal address exception', () => {
  const body = Uint8Array.from([1, 0x83, 2]);
  const crc = crc16(body);
  assert.throws(() => parseRtuResponse(Uint8Array.from([...body, crc & 255, crc >> 8]), { unitId: 1, functionCode: 3, count: 1 }), e => e.kind === 'exception' && e.exceptionCode === 2);
});

test('reads fragmented RTU response through serial streams', async () => {
  const chunks = [Uint8Array.from([1, 3]), Uint8Array.from([2, 0x12, 0x34, 0xb5, 0x33])];
  const written = [];
  const port = {
    async open() {}, async close() {},
    readable: { getReader: () => ({ read: async () => ({ value: chunks.shift() }), releaseLock() {}, cancel() {} }) },
    writable: { getWriter: () => ({ write: async bytes => written.push([...bytes]), releaseLock() {} }) }
  };
  const client = new RtuClient(port);
  await client.open({ baudRate: 9600 });
  assert.deepEqual(await client.read({ unitId: 1, functionCode: 3, address: 0, count: 1, timeoutMs: 1000 }), [0x1234]);
  assert.equal(written.length, 1);
  await client.close();
});

test('keeps serial stream usable after a complete exception response', async () => {
  const exception = Uint8Array.from([1, 0x83, 2]);
  const crc = crc16(exception);
  let cancelled = 0;
  const port = {
    async open() {}, async close() {},
    readable: { getReader: () => ({ read: async () => ({ value: Uint8Array.from([...exception, crc & 255, crc >> 8]) }), releaseLock() {}, cancel: async () => { cancelled++; } }) },
    writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) }
  };
  const client = new RtuClient(port);
  await client.open({ baudRate: 9600 });
  await assert.rejects(client.read({ unitId: 1, functionCode: 3, address: 0, count: 1 }), e => e.exceptionCode === 2);
  assert.equal(cancelled, 0);
  assert.equal(client.busy, false);
});

test('releases busy state when serial write fails', async () => {
  const port = {
    async open() {}, async close() {},
    writable: { getWriter: () => ({ write: async () => { throw new Error('write failed'); }, releaseLock() {} }) }
  };
  const client = new RtuClient(port);
  await client.open({ baudRate: 9600 });
  await assert.rejects(client.read({ unitId: 1, functionCode: 3, address: 0, count: 1 }), /write failed/);
  assert.equal(client.busy, false);
});

test('times out a stalled serial write and refuses further reads until reconnect', async () => {
  const port = {
    async open() {}, async close() {},
    writable: { getWriter: () => ({ write: () => new Promise(() => {}), abort: async () => {}, releaseLock() {} }) }
  };
  const client = new RtuClient(port);
  await client.open({ baudRate: 9600 });
  await assert.rejects(client.read({ unitId: 1, functionCode: 3, address: 0, count: 1, timeoutMs: 100 }), /timeout/i);
  assert.equal(client.busy, false);
  await assert.rejects(client.read({ unitId: 1, functionCode: 3, address: 1, count: 1, timeoutMs: 100 }), /เชื่อมต่อใหม่|reconnect/i);
  await client.close();
});

test('does not send another RTU request after partial response timeout', async () => {
  let writes = 0;
  const port = {
    async open() {}, async close() {},
    readable: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async () => { writes++; }, releaseLock() {} }) }
  };
  const client = new RtuClient(port);
  await client.open({ baudRate: 9600 });
  await assert.rejects(client.read({ unitId: 1, functionCode: 3, address: 0, count: 1, timeoutMs: 100 }), /timeout/i);
  await assert.rejects(client.read({ unitId: 1, functionCode: 3, address: 1, count: 1, timeoutMs: 100 }), /เชื่อมต่อใหม่|reconnect/i);
  assert.equal(writes, 1);
});

function frameWithCrc(bytes) {
  const crc = crc16(Uint8Array.from(bytes));
  return Uint8Array.from([...bytes, crc & 255, crc >> 8]);
}

function fakePort(responses, written = []) {
  return {
    async open() {}, async close() {},
    readable: { getReader: () => ({ read: async () => (responses.length ? { value: responses.shift() } : new Promise(() => {})), cancel: async () => {}, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: async bytes => { written.push([...bytes]); }, releaseLock() {} }) }
  };
}

test('reads several registers in one request, as grouped live polling does', async () => {
  const written = [];
  const client = new RtuClient(fakePort([frameWithCrc([5, 4, 6, 0, 1, 0, 2, 0xff, 0xff])], written));
  await client.open({ baudRate: 9600 });
  assert.deepEqual(await client.read({ unitId: 5, functionCode: 4, address: 10, count: 3, timeoutMs: 1000 }), [1, 2, 0xffff]);
  assert.deepEqual(written[0].slice(0, 6), [5, 4, 0, 10, 0, 3]);
  await client.close();
});

test('decodes coil bits least-significant bit first across bytes', async () => {
  const client = new RtuClient(fakePort([frameWithCrc([1, 1, 2, 0b00000101, 0b00000001])]));
  await client.open({ baudRate: 9600 });
  assert.deepEqual(await client.read({ unitId: 1, functionCode: 1, address: 0, count: 9, timeoutMs: 1000 }), [1, 0, 1, 0, 0, 0, 0, 0, 1]);
  await client.close();
});

test('two consecutive reads share the open port', async () => {
  const client = new RtuClient(fakePort([frameWithCrc([1, 3, 2, 0, 7]), frameWithCrc([1, 3, 2, 0, 8])]));
  await client.open({ baudRate: 9600 });
  assert.deepEqual(await client.read({ unitId: 1, functionCode: 3, address: 0, count: 1, timeoutMs: 1000 }), [7]);
  assert.deepEqual(await client.read({ unitId: 1, functionCode: 3, address: 1, count: 1, timeoutMs: 1000 }), [8]);
  await client.close();
});

test('rejects trailing bytes after a frame and requires reconnect', async () => {
  const frame = frameWithCrc([1, 3, 2, 0, 7]);
  const client = new RtuClient(fakePort([Uint8Array.from([...frame, 0x99])]));
  await client.open({ baudRate: 9600 });
  await assert.rejects(client.read({ unitId: 1, functionCode: 3, address: 0, count: 1, timeoutMs: 1000 }), error => error.terminal === true);
  assert.equal(client.desynced, true);
  await assert.rejects(client.read({ unitId: 1, functionCode: 3, address: 0, count: 1, timeoutMs: 1000 }), /เชื่อมต่อใหม่/);
});

test('rejects a reply from a different unit ID', async () => {
  const client = new RtuClient(fakePort([frameWithCrc([2, 3, 2, 0, 7])]));
  await client.open({ baudRate: 9600 });
  await assert.rejects(client.read({ unitId: 1, functionCode: 3, address: 0, count: 1, timeoutMs: 1000 }), /Unit ID/);
});

test('refuses a second read while one is in flight', async () => {
  const client = new RtuClient(fakePort([]));
  await client.open({ baudRate: 9600 });
  const first = client.read({ unitId: 1, functionCode: 3, address: 0, count: 1, timeoutMs: 200 });
  await assert.rejects(client.read({ unitId: 1, functionCode: 3, address: 1, count: 1, timeoutMs: 200 }), /ยังไม่เสร็จ/);
  await assert.rejects(first, /timeout/i);
});

test('an abort signal cancels a pending read promptly', async () => {
  const client = new RtuClient(fakePort([]));
  await client.open({ baudRate: 9600 });
  const controller = new AbortController();
  const started = Date.now();
  const pending = client.read({ unitId: 1, functionCode: 3, address: 0, count: 1, timeoutMs: 5000, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, error => error.kind === 'cancelled');
  assert.ok(Date.now() - started < 1000);
  assert.equal(client.busy, false);
});

test('rejects unit ID 0 because broadcast reads get no reply', async () => {
  const client = new RtuClient(fakePort([]));
  await client.open({ baudRate: 9600 });
  await assert.rejects(client.read({ unitId: 0, functionCode: 3, address: 0, count: 1 }), error => error.kind === 'input');
});
