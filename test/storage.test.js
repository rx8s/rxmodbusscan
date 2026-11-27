import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../src/storage.js';

test('persists scan runs and live samples in a SQLite file across reopen', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'modbus-db-'));
  const file = path.join(directory, 'scan.db');
  const first = createStore(file, { liveRetentionDays: 0 });
  try {
    const older = first.saveScan({ context: { transport: 'tcp', host: '192.168.1.10', port: 502, unitId: 1 }, summary: { readable: 1 }, rows: [{ status: 'ok', functionCode: 3, address: 0, value: 100, time: 1000 }], failures: [], selected: ['3:0'] });
    const latest = first.saveScan({ context: { transport: 'rtu' }, summary: { readable: 1, invalid: 1 }, rows: [{ status: 'ok', functionCode: 4, address: 12, value: 321, time: 2000 }], failures: [{ status: 'invalid', functionCode: 4, address: 13, count: 1, message: 'illegal address' }], selected: ['4:12'] });
    first.saveLive(latest, { functionCode: 4, address: 12, value: 322, status: 'ok', time: 2100 });
    first.setSelection(latest, []);
    first.close();
    assert.equal(existsSync(file), true);
    const reopened = createStore(file, { liveRetentionDays: 0 });
    try {
      assert.equal(reopened.latestScan().id, latest);
      assert.deepEqual(reopened.latestScan().rows, [{ status: 'ok', functionCode: 4, address: 12, value: 321, time: 2000 }]);
      assert.deepEqual(reopened.latestScan().failures, [{ status: 'invalid', functionCode: 4, address: 13, count: 1, message: 'illegal address' }]);
      assert.deepEqual(reopened.latestScan().selected, []);
      assert.equal(reopened.getLive(latest)[0].value, 322);
      assert.equal(reopened.getLive(older).length, 0);
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('saves live samples in one batch and prunes samples past the retention window', () => {
  let clock = 100 * 86400000;
  const store = createStore(':memory:', { liveRetentionDays: 30, now: () => clock });
  try {
    const id = store.saveScan({ context: { transport: 'rtu' }, summary: {}, rows: [], failures: [], selected: [] });
    store.saveLiveBatch(id, [
      { functionCode: 3, address: 1, value: 1, status: 'ok', time: clock - 31 * 86400000 },
      { functionCode: 3, address: 1, value: 2, status: 'ok', time: clock - 1000 },
      { functionCode: 3, address: 1, status: 'failed', time: clock, message: 'timeout' }
    ]);
    assert.equal(store.getLive(id).length, 3);
    assert.equal(store.pruneLive(), 1);
    assert.deepEqual(store.getLive(id).map(row => row.status), ['ok', 'failed']);
  } finally { store.close(); }
});

test('keeps all live samples when retention is disabled', () => {
  const store = createStore(':memory:', { liveRetentionDays: 0 });
  try {
    const id = store.saveScan({ context: { transport: 'rtu' }, summary: {}, rows: [], failures: [], selected: [] });
    store.saveLive(id, { functionCode: 3, address: 1, value: 1, status: 'ok', time: 1 });
    assert.equal(store.pruneLive(), 0);
    assert.equal(store.getLive(id).length, 1);
  } finally { store.close(); }
});
