import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readTcp } from './tcp-client.js';
import { validateRead } from './protocol.js';

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

export function createAppServer({ read = readTcp } = {}) {
  return http.createServer(async (req, res) => {
    const host = req.headers.host || '';
    const hostname = host.replace(/:\d+$/, '').toLowerCase();
    if (!['localhost', '127.0.0.1'].includes(hostname)) return json(res, 403, { error: 'Localhost only' });
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: 'Origin mismatch' });
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { return json(res, 400, { error: 'Invalid request URL' }); }
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
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8876);
  createAppServer().listen(port, '127.0.0.1', () => {
    console.log(`Modbus Scanner: http://localhost:${port}`);
  });
}
