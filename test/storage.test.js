import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../src/storage.js';

test('persists scan runs and live samples in a SQLite file across reopen', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'modbus-db-'));
  const file = path.join(directory, 'scan.db');
  const first = createStore(file);
  try {
    const older = first.saveScan({ context: { transport: 'tcp', host: '192.168.1.10', port: 502, unitId: 1 }, summary: { readable: 1 }, rows: [{ status: 'ok', functionCode: 3, address: 0, value: 100, time: 1000 }], failures: [], selected: ['3:0'] });
    const latest = first.saveScan({ context: { transport: 'rtu' }, summary: { readable: 1, invalid: 1 }, rows: [{ status: 'ok', functionCode: 4, address: 12, value: 321, time: 2000 }], failures: [{ status: 'invalid', functionCode: 4, address: 13, count: 1, message: 'illegal address' }], selected: ['4:12'] });
    first.saveLive(latest, { functionCode: 4, address: 12, value: 322, status: 'ok', time: 2100 });
    first.setSelection(latest, []);
    first.close();
    assert.equal(existsSync(file), true);
    const reopened = createStore(file);
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
