import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeValues, validateRead, parseTcpResponse, ModbusError } from '../src/protocol.js';

test('decodes register and packed bit responses', () => {
  assert.deepEqual(decodeValues(3, Buffer.from([0x12, 0x34, 0xff, 0xfe]), 2), [0x1234, 0xfffe]);
  assert.deepEqual(decodeValues(1, Buffer.from([0b00000101]), 3), [1, 0, 1]);
});

test('rejects invalid read boundaries', () => {
  assert.throws(() => validateRead({ unitId: 1, functionCode: 3, address: 65535, count: 2 }), /address range/);
  assert.throws(() => validateRead({ unitId: 1, functionCode: 3, address: 0, count: 126 }), /count/);
  assert.throws(() => validateRead({ unitId: 1, functionCode: 1, address: 0, count: 2001 }), /count/);
});

test('rejects mismatched and truncated TCP frames', () => {
  const frame = Buffer.from([0, 2, 0, 0, 0, 5, 1, 3, 2, 0, 9]);
  assert.throws(() => parseTcpResponse(frame, { transactionId: 1, unitId: 1, functionCode: 3, count: 1 }), /transaction/);
  assert.throws(() => parseTcpResponse(frame.subarray(0, 9), { transactionId: 2, unitId: 1, functionCode: 3, count: 1 }), /short|length/);
});

test('classifies Modbus exceptions', () => {
  const frame = Buffer.from([0, 2, 0, 0, 0, 3, 1, 0x83, 2]);
  assert.throws(() => parseTcpResponse(frame, { transactionId: 2, unitId: 1, functionCode: 3, count: 1 }), e => e instanceof ModbusError && e.kind === 'exception' && e.exceptionCode === 2);
});
