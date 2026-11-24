import net from 'node:net';
import { ModbusError, parseTcpResponse, validateRead } from './protocol.js';

let nextTransactionId = 0;

export async function readTcp(options) {
  const { host, port, unitId, functionCode, address, count, timeoutMs = 1500 } = options;
  validateRead(options);
  if (typeof host !== 'string' || !host.trim() || host.length > 253) throw new ModbusError('host is required', 'input');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ModbusError('port must be 1–65535', 'input');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new ModbusError('timeoutMs must be 100–30000', 'input');
  const transactionId = nextTransactionId = (nextTransactionId + 1) & 0xffff;
  const request = Buffer.alloc(12);
  request.writeUInt16BE(transactionId, 0);
  request.writeUInt16BE(6, 4);
  request[6] = unitId;
  request[7] = functionCode;
  request.writeUInt16BE(address, 8);
  request.writeUInt16BE(count, 10);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = (error, values) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(values);
    };
    socket.setTimeout(timeoutMs, () => finish(new ModbusError('TCP timeout', 'transport')));
    socket.on('error', error => finish(new ModbusError(error.message, 'transport')));
    socket.on('connect', () => socket.write(request));
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= 6) {
        const length = received.readUInt16BE(4);
        if (length < 3 || length > 254) return finish(new ModbusError('invalid TCP frame length'));
        const total = length + 6;
        if (received.length >= total) {
          try {
            if (received.length !== total) throw new ModbusError('extra TCP response bytes');
            finish(null, parseTcpResponse(received, { transactionId, unitId, functionCode, count }));
          } catch (error) { finish(error); }
        }
      }
    });
    socket.on('end', () => finish(new ModbusError('short TCP response', 'transport')));
  });
}
