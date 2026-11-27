import net from 'node:net';
import { ModbusError, parseTcpResponse, validateRead } from './protocol.js';

let nextTransactionId = 0;

// One socket per host:port, reused across requests. Requests to the same device are
// serialized because many Modbus devices accept only a few connections and answer
// one request at a time. Idle sockets are unref'd and closed after IDLE_MS.
export const IDLE_MS = 5000;
const pool = new Map();

function entryFor(key) {
  let entry = pool.get(key);
  if (!entry) { entry = { socket: null, queue: Promise.resolve(), idleTimer: null }; pool.set(key, entry); }
  return entry;
}

function dropSocket(entry, socket) {
  if (entry.socket === socket) entry.socket = null;
  socket.destroy();
}

function waitTurn(previous, deadline, signal) {
  let timer;
  let onAbort;
  return Promise.race([
    previous,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new ModbusError('TCP timeout', 'transport')), Math.max(0, deadline - Date.now())); }),
    new Promise((_, reject) => {
      onAbort = () => reject(new ModbusError('TCP cancelled', 'cancelled'));
      if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    })
  ]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); });
}

function transact(entry, { host, port, unitId, functionCode, count, request, transactionId, deadline, signal }) {
  return new Promise((resolve, reject) => {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    let socket = entry.socket;
    const reused = !!socket && !socket.destroyed;
    if (!reused) {
      socket = net.createConnection({ host, port });
      socket.setNoDelay(true);
      socket.on('error', () => {});
      socket.on('close', () => { if (entry.socket === socket) entry.socket = null; });
      entry.socket = socket;
    }
    socket.ref();
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = (error, values) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
      socket.off('connect', send);
      // A Modbus exception is a complete, well-formed reply, so the socket stays in sync and can be reused.
      if (error && error.kind !== 'exception') {
        // Never reuse a socket after any other failure: a late reply would desync the next request.
        dropSocket(entry, socket);
        // A pooled socket the device closed while idle fails before any byte arrives; retry once.
        if (reused && !received.length && error.kind === 'transport' && !error.timeout) error.retryable = true;
        return reject(error);
      }
      socket.unref();
      entry.idleTimer = setTimeout(() => dropSocket(entry, socket), IDLE_MS);
      entry.idleTimer.unref();
      if (error) reject(error); else resolve(values);
    };
    const timeoutError = () => Object.assign(new ModbusError('TCP timeout', 'transport'), { timeout: true });
    const timer = setTimeout(() => finish(timeoutError()), Math.max(0, deadline - Date.now()));
    const abort = () => finish(new ModbusError('TCP cancelled', 'cancelled'));
    const onError = error => finish(new ModbusError(error.message, 'transport'));
    const onEnd = () => finish(new ModbusError('short TCP response', 'transport'));
    const onData = chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 6) return;
      const length = received.readUInt16BE(4);
      if (length < 3 || length > 254) return finish(new ModbusError('invalid TCP frame length'));
      const total = length + 6;
      if (received.length < total) return;
      try {
        if (received.length !== total) throw new ModbusError('extra TCP response bytes');
        finish(null, parseTcpResponse(received, { transactionId, unitId, functionCode, count }));
      } catch (error) { finish(error); }
    };
    const send = () => socket.write(request);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
    if (reused) send(); else socket.once('connect', send);
  });
}

export async function readTcp(options) {
  const { host, port, unitId, functionCode, address, count, timeoutMs = 1500, signal } = options;
  validateRead(options);
  if (typeof host !== 'string' || !host.trim() || host.length > 253) throw new ModbusError('host is required', 'input');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ModbusError('port must be 1–65535', 'input');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new ModbusError('timeoutMs must be 100–30000', 'input');
  const deadline = Date.now() + timeoutMs;
  const entry = entryFor(`${host}:${port}`);
  const previous = entry.queue;
  let release;
  const mine = new Promise(resolve => { release = resolve; });
  // The next caller waits for both the previous request and this one, even if this one gives up early.
  entry.queue = previous.then(() => mine);
  try {
    await waitTurn(previous, deadline, signal);
    const attempt = () => {
      const transactionId = nextTransactionId = (nextTransactionId + 1) & 0xffff;
      const request = Buffer.alloc(12);
      request.writeUInt16BE(transactionId, 0);
      request.writeUInt16BE(6, 4);
      request[6] = unitId;
      request[7] = functionCode;
      request.writeUInt16BE(address, 8);
      request.writeUInt16BE(count, 10);
      return transact(entry, { host, port, unitId, functionCode, count, request, transactionId, deadline, signal });
    };
    try { return await attempt(); }
    catch (error) { if (error.retryable && Date.now() < deadline) return await attempt(); throw error; }
  } finally { release(); }
}

export function closeTcpConnections() {
  for (const entry of pool.values()) {
    clearTimeout(entry.idleTimer);
    entry.socket?.destroy();
  }
  pool.clear();
}
