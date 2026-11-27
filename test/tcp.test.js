import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readTcp, closeTcpConnections } from '../src/tcp-client.js';

test('reads a holding register from a TCP device', async () => {
  const server = net.createServer(socket => socket.once('data', req => {
    assert.equal(req[7], 3);
    const response = Buffer.from([req[0], req[1], 0, 0, 0, 5, req[6], 3, 2, 0x12, 0x34]);
    socket.write(response.subarray(0, 6));
    setTimeout(() => socket.end(response.subarray(6)), 5);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    assert.deepEqual(await readTcp({ host: '127.0.0.1', port: server.address().port, unitId: 1, functionCode: 3, address: 0, count: 1, timeoutMs: 1000 }), [0x1234]);
  } finally { server.close(); }
});

test('applies an absolute TCP deadline despite trickled bytes', async () => {
  const server = net.createServer(socket => {
    socket.on('data', () => {
      socket.write(Buffer.from([0, 1, 0, 0, 0, 200]));
      const timer = setInterval(() => socket.write(Buffer.from([0])), 40);
      socket.on('close', () => clearInterval(timer));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const started = Date.now();
  try {
    await assert.rejects(readTcp({ host: '127.0.0.1', port: server.address().port, unitId: 1, functionCode: 3, address: 0, count: 1, timeoutMs: 100 }), /timeout/i);
    assert.ok(Date.now() - started < 350);
  } finally { server.close(); }
});

test('aborts a pending TCP read', async () => {
  const server = net.createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  try {
    const pending = readTcp({ host: '127.0.0.1', port: server.address().port, unitId: 1, functionCode: 3, address: 0, count: 1, timeoutMs: 1000, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /cancel/i);
  } finally { server.close(); }
});

function echoDevice(onConnection = () => {}, delayMs = 0) {
  return net.createServer(socket => {
    onConnection(socket);
    socket.on('data', req => setTimeout(() => socket.write(Buffer.from([req[0], req[1], 0, 0, 0, 5, req[6], 3, 2, 0, req[9]])), delayMs));
  });
}

test('reuses one TCP connection for consecutive reads', async () => {
  let connections = 0;
  const server = echoDevice(() => connections++);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const options = { host: '127.0.0.1', port: server.address().port, unitId: 1, functionCode: 3, count: 1, timeoutMs: 1000 };
  try {
    for (const address of [1, 2, 3]) assert.deepEqual(await readTcp({ ...options, address }), [address]);
    assert.equal(connections, 1);
  } finally { closeTcpConnections(); server.close(); }
});

test('serializes concurrent reads to the same device', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const server = net.createServer(socket => socket.on('data', req => {
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    setTimeout(() => { inFlight--; socket.write(Buffer.from([req[0], req[1], 0, 0, 0, 5, req[6], 3, 2, 0, req[9]])); }, 10);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const options = { host: '127.0.0.1', port: server.address().port, unitId: 1, functionCode: 3, count: 1, timeoutMs: 1000 };
  try {
    const values = await Promise.all([4, 5, 6].map(address => readTcp({ ...options, address })));
    assert.deepEqual(values, [[4], [5], [6]]);
    assert.equal(maxInFlight, 1);
  } finally { closeTcpConnections(); server.close(); }
});

test('reconnects when the device closed the pooled connection', async () => {
  let connections = 0;
  const sockets = [];
  const server = echoDevice(socket => { connections++; sockets.push(socket); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const options = { host: '127.0.0.1', port: server.address().port, unitId: 1, functionCode: 3, count: 1, timeoutMs: 1000 };
  try {
    assert.deepEqual(await readTcp({ ...options, address: 1 }), [1]);
    sockets[0].destroy();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(await readTcp({ ...options, address: 2 }), [2]);
    assert.equal(connections, 2);
  } finally { closeTcpConnections(); server.close(); }
});

test('opens a fresh connection after a timeout so late replies cannot desync', async () => {
  let connections = 0;
  let first = true;
  const server = net.createServer(socket => {
    connections++;
    socket.on('data', req => {
      const delay = first ? 150 : 0;
      first = false;
      setTimeout(() => { if (!socket.destroyed) socket.write(Buffer.from([req[0], req[1], 0, 0, 0, 5, req[6], 3, 2, 0, req[9]])); }, delay);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const options = { host: '127.0.0.1', port: server.address().port, unitId: 1, functionCode: 3, count: 1 };
  try {
    await assert.rejects(readTcp({ ...options, address: 1, timeoutMs: 100 }), /timeout/i);
    assert.deepEqual(await readTcp({ ...options, address: 2, timeoutMs: 1000 }), [2]);
    assert.equal(connections, 2);
  } finally { closeTcpConnections(); server.close(); }
});

test('keeps the connection after a Modbus exception reply', async () => {
  let connections = 0;
  const server = net.createServer(socket => {
    connections++;
    socket.on('data', req => socket.write(req[9] === 9
      ? Buffer.from([req[0], req[1], 0, 0, 0, 3, req[6], 0x83, 2])
      : Buffer.from([req[0], req[1], 0, 0, 0, 5, req[6], 3, 2, 0, req[9]])));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const options = { host: '127.0.0.1', port: server.address().port, unitId: 1, functionCode: 3, count: 1, timeoutMs: 1000 };
  try {
    await assert.rejects(readTcp({ ...options, address: 9 }), error => error.kind === 'exception' && error.exceptionCode === 2);
    assert.deepEqual(await readTcp({ ...options, address: 1 }), [1]);
    assert.equal(connections, 1);
  } finally { closeTcpConnections(); server.close(); }
});
