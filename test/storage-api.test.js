import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../src/server.js';
import { createStore } from '../src/storage.js';

test('saves a scan from the browser and returns it after a reload request', async () => {
  const store = createStore(':memory:');
  const server = createAppServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const payload = { context: { transport: 'tcp', host: '192.168.1.10', port: 502, unitId: 1 }, summary: { readable: 1, invalid: 0 }, rows: [{ status: 'ok', functionCode: 3, address: 7, value: 42, time: 1000 }], failures: [], selected: ['3:7'] };
    const saved = await fetch(`${base}/api/scans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(saved.status, 201);
    const { id } = await saved.json();
    const latest = await fetch(`${base}/api/scans/latest`);
    assert.equal(latest.status, 200);
    assert.deepEqual((await latest.json()).rows, payload.rows);
    const selection = await fetch(`${base}/api/scans/${id}/selection`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected: [] }) });
    assert.equal(selection.status, 200);
    const live = await fetch(`${base}/api/scans/${id}/live`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ functionCode: 3, address: 7, value: 43, status: 'ok', time: 2000 }) });
    assert.equal(live.status, 201);
    assert.deepEqual(store.getLive(id)[0].value, 43);
    assert.deepEqual((await (await fetch(`${base}/api/scans/latest`)).json()).selected, []);
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
});

test('rejects malformed scan rows without writing a scan', async () => {
  const store = createStore(':memory:');
  const server = createAppServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/scans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context: { transport: 'tcp' }, summary: {}, rows: [{ status: 'ok', functionCode: 9, address: 65536, value: 1, time: 1 }], failures: [], selected: [] }) });
    assert.equal(response.status, 400);
    assert.equal(store.latestScan(), null);
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
});
