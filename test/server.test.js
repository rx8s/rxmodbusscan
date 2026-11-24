import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAppServer } from '../src/server.js';

test('serves the UI and forwards bounded TCP reads', async () => {
  const calls = [];
  const server = createAppServer({ read: async request => { calls.push(request); return [77]; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Modbus/);
    assert.match(html, /ผลสแกนครั้งเดียว/);
    assert.match(html, /ค่าสด/);
    for (const asset of ['/tokens.css', '/theme.css']) {
      const stylesheet = await fetch(`${base}${asset}`);
      assert.equal(stylesheet.status, 200);
      assert.match(stylesheet.headers.get('content-type'), /text\/css/);
      assert.match(await stylesheet.text(), /--color-|\.sidebar/);
    }
    const response = await fetch(`${base}/api/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: '192.168.1.20', port: 502, unitId: 1, functionCode: 3, address: 10, count: 1 }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { values: [77] });
    assert.equal(calls[0].address, 10);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('rejects nonlocal Host headers', async () => {
  const server = createAppServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/', headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('returns 400 for invalid TCP target settings', async () => {
  const server = createAppServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: '', port: 0, unitId: 1, functionCode: 3, address: 0, count: 1 }) });
    assert.equal(response.status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('returns 400 for a malformed request target without throwing', () => {
  const server = createAppServer();
  let status;
  server.emit('request', { headers: { host: 'localhost' }, url: 'http://[', method: 'GET' }, { writeHead(code) { status = code; }, end() {} });
  assert.equal(status, 400);
  server.close();
});
