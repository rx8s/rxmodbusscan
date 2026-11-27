import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readTcp } from './tcp-client.js';
import { validateRead } from './protocol.js';
import { createStore } from './storage.js';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/theme.css', ['theme.css', 'text/css; charset=utf-8']],
  ['/tokens.css', ['../design-system/modbus-scan/tokens.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/scan.js', ['scan.js', 'text/javascript; charset=utf-8']],
  ['/live.js', ['live.js', 'text/javascript; charset=utf-8']],
  ['/rtu.js', ['rtu.js', 'text/javascript; charset=utf-8']]
]);

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function invalid(message) { const error = new Error(message); error.kind = 'input'; throw error; }
function integer(value, min, max) { return Number.isInteger(value) && value >= min && value <= max; }
function validateSelection(selected) {
  if (!Array.isArray(selected) || selected.length > 262144 || selected.some(key => typeof key !== 'string' || !/^[1-4]:(0|[1-9]\d{0,4})$/.test(key) || Number(key.split(':')[1]) > 65535)) invalid('รายการ LIVE ไม่ถูกต้อง');
}
function validateResult(row, failure = false) {
  if (!row || !integer(row.functionCode, 1, 4) || !integer(row.address, 0, 65535) || (failure ? !['invalid', 'failed', 'unsupported'].includes(row.status) : row.status !== 'ok')) invalid('ผลสแกนไม่ถูกต้อง');
  if (failure) {
    if (!integer(row.count, 1, 65536 - row.address) || typeof row.message !== 'string' || row.message.length > 1000) invalid('ผลสแกนที่อ่านไม่ได้ไม่ถูกต้อง');
  } else if (!integer(row.value, 0, row.functionCode <= 2 ? 1 : 65535) || !integer(row.time, 0, Number.MAX_SAFE_INTEGER)) invalid('ค่าที่อ่านได้ไม่ถูกต้อง');
}
function validateScan(body) {
  if (!body || !body.context || !['tcp', 'rtu'].includes(body.context.transport) || !body.summary || typeof body.summary !== 'object' || !Array.isArray(body.rows) || body.rows.length > 262144 || !Array.isArray(body.failures) || body.failures.length > 1000) invalid('ข้อมูลรอบสแกนไม่ถูกต้อง');
  if (body.context.transport === 'tcp' && (typeof body.context.host !== 'string' || !body.context.host.trim() || body.context.host.length > 255 || !integer(body.context.port, 1, 65535) || !integer(body.context.unitId, 0, 247))) invalid('ข้อมูล TCP ไม่ถูกต้อง');
  validateSelection(body.selected);
  body.rows.forEach(row => validateResult(row));
  body.failures.forEach(row => validateResult(row, true));
}
async function readJson(req, limit) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') invalid('ต้องส่ง JSON');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) invalid('ข้อมูลใหญ่เกินกำหนด'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return invalid('JSON ไม่ถูกต้อง'); }
}

export function createAppServer({ read = readTcp, store = null } = {}) {
  const storage = () => { store ??= createStore(); return store; };
  const handle = async (req, res) => {
    const host = req.headers.host || '';
    const hostname = host.replace(/:\d+$/, '').toLowerCase();
    if (!['localhost', '127.0.0.1'].includes(hostname)) return json(res, 403, { error: 'Localhost only' });
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: 'Origin mismatch' });
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { return json(res, 400, { error: 'Invalid request URL' }); }
    if (pathname === '/api/scans/latest' && req.method === 'GET') return json(res, 200, storage().latestScan());
    if (pathname === '/api/scans' && req.method === 'POST') {
      try { const body = await readJson(req, 64 * 1024 * 1024); validateScan(body); return json(res, 201, { id: storage().saveScan(body) }); }
      catch (error) { return json(res, error.kind === 'input' ? 400 : 500, { error: error.message }); }
    }
    const scanRoute = pathname.match(/^\/api\/scans\/([1-9]\d*)\/(selection|live)$/);
    if (scanRoute && ['PUT', 'POST'].includes(req.method)) {
      try {
        const id = Number(scanRoute[1]);
        if (!Number.isSafeInteger(id) || !storage().hasScan(id)) return json(res, 404, { error: 'ไม่พบรอบสแกน' });
        const body = await readJson(req, 1024 * 1024);
        if (scanRoute[2] === 'selection' && req.method === 'PUT') { validateSelection(body?.selected); storage().setSelection(id, body.selected); return json(res, 200, { saved: true }); }
        if (scanRoute[2] === 'live' && req.method === 'POST') {
          if (!body || !integer(body.functionCode, 1, 4) || !integer(body.address, 0, 65535) || !['ok', 'failed'].includes(body.status) || !integer(body.time, 0, Number.MAX_SAFE_INTEGER) || (body.value != null && !integer(body.value, 0, body.functionCode <= 2 ? 1 : 65535)) || (body.message != null && (typeof body.message !== 'string' || body.message.length > 1000))) invalid('ค่าสดไม่ถูกต้อง');
          storage().saveLive(id, body); return json(res, 201, { saved: true });
        }
        return json(res, 405, { error: 'Method not allowed' });
      } catch (error) { return json(res, error.kind === 'input' ? 400 : 500, { error: error.message }); }
    }
    if (pathname === '/api/read' && req.method === 'POST') {
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'JSON required' });
      let text = '';
      try {
        for await (const chunk of req) {
          text += chunk;
          if (text.length > 8192) return json(res, 413, { error: 'Request too large' });
        }
        const body = JSON.parse(text);
        validateRead(body);
        if (typeof body.host !== 'string' || !body.host.trim() || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
          const error = new Error('Host หรือ Port ไม่ถูกต้อง'); error.kind = 'input'; throw error;
        }
        const controller = new AbortController();
        res.once('close', () => controller.abort());
        const values = await read({ ...body, signal: controller.signal });
        return json(res, 200, { values });
      } catch (error) {
        return json(res, error.kind === 'input' || error instanceof SyntaxError ? 400 : 502, { error: error.message, kind: error.kind || 'transport', exceptionCode: error.exceptionCode });
      }
    }
    if (req.method !== 'GET' || !assets.has(pathname)) return json(res, 404, { error: 'Not found' });
    const [filename, type] = assets.get(pathname);
    try {
      const data = await readFile(path.join(webRoot, filename));
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(data);
    } catch { json(res, 500, { error: 'Asset unavailable' }); }
  };
  return http.createServer((req, res) => {
    handle(req, res).catch(error => {
      if (res.headersSent) res.destroy(error);
      else json(res, 500, { error: error?.message || 'Internal server error' });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8876);
  createAppServer().listen(port, '127.0.0.1', () => {
    console.log(`Modbus Scanner: http://localhost:${port}`);
  });
}
