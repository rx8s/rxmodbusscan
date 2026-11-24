import test from 'node:test';
import assert from 'node:assert/strict';
import { scan, referenceLabel } from '../web/scan.js';

test('uses conventional five-digit reference for first addresses', () => {
  assert.equal(referenceLabel(3, 0), '40001');
  assert.equal(referenceLabel(4, 10), '30011');
});

test('splits illegal-address blocks and retains readable neighbors', async () => {
  const found = [];
  const summary = await scan({
    read: async ({ address, count }) => {
      if (address <= 2 && address + count > 2) throw { kind: 'exception', exceptionCode: 2 };
      return Array.from({ length: count }, (_, i) => address + i + 100);
    },
    areas: [3], start: 0, end: 3, chunkSize: 4,
    onResult: result => found.push(result)
  });
  assert.deepEqual(found.filter(x => x.status === 'ok').map(x => x.address), [0, 1, 3]);
  assert.equal(summary.readable, 3);
  assert.equal(summary.invalid, 1);
  assert.equal(summary.processed, 4);
});

test('skips remaining area after unsupported function', async () => {
  let calls = 0;
  const summary = await scan({ read: async () => { calls++; throw { kind: 'exception', exceptionCode: 1 }; }, areas: [1], start: 0, end: 65535 });
  assert.equal(calls, 1);
  assert.equal(summary.unsupported, 65536);
  assert.equal(summary.processed, 65536);
});

test('reports only the unprocessed suffix when an area becomes unsupported', async () => {
  const failures = [];
  const summary = await scan({ read: async ({ address, count }) => { if (address >= 2) throw { kind: 'exception', exceptionCode: 1 }; return Array(count).fill(1); }, areas: [1], start: 0, end: 5, chunkSize: 2, onResult: row => { if (row.status !== 'ok') failures.push(row); } });
  assert.equal(summary.readable, 2);
  assert.equal(summary.unsupported, 4);
  assert.deepEqual([failures[0].address, failures[0].count], [2, 4]);
});

test('stops between read requests when cancelled', async () => {
  const controller = new AbortController();
  let calls = 0;
  const summary = await scan({ read: async ({ count }) => { calls++; controller.abort(); return Array(count).fill(1); }, areas: [4], start: 0, end: 10, chunkSize: 2, signal: controller.signal });
  assert.equal(calls, 1);
  assert.equal(summary.cancelled, true);
  assert.equal(summary.processed, 0);
});

test('stops scanning after a terminal transport error', async () => {
  let calls = 0;
  const summary = await scan({ read: async () => { calls++; const error = new Error('serial out of sync'); error.terminal = true; throw error; }, areas: [3], start: 0, end: 100, chunkSize: 2 });
  assert.equal(calls, 1);
  assert.equal(summary.stopped, true);
  assert.equal(summary.failed, 2);
});

test('uses 0–65535 for full scan mode', async () => {
  const requests = [];
  await scan({ read: async ({ address, count }) => { requests.push([address, count]); return Array(count).fill(0); }, areas: [3], start: 0, end: 65535, chunkSize: 125 });
  assert.deepEqual(requests.at(-1), [65500, 36]);
  assert.equal(requests.length, 525);
});
