import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readTcp } from '../src/tcp-client.js';

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
