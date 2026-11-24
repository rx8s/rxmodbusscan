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
