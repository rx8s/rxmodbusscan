export class ModbusError extends Error {
  constructor(message, kind = 'protocol', exceptionCode) {
    super(message);
    this.name = 'ModbusError';
    this.kind = kind;
    this.exceptionCode = exceptionCode;
  }
}

export function validateRead({ unitId, functionCode, address, count }) {
  if (!Number.isInteger(unitId) || unitId < 0 || unitId > 247) throw new ModbusError('unitId must be 0–247', 'input');
  if (![1, 2, 3, 4].includes(functionCode)) throw new ModbusError('functionCode must be 1–4', 'input');
  if (!Number.isInteger(address) || address < 0 || address > 65535) throw new ModbusError('address must be 0–65535', 'input');
  const maximum = functionCode <= 2 ? 2000 : 125;
  if (!Number.isInteger(count) || count < 1 || count > maximum) throw new ModbusError(`count must be 1–${maximum}`, 'input');
  if (address + count > 65536) throw new ModbusError('address range exceeds 65535', 'input');
}

export function decodeValues(functionCode, data, count) {
  const expected = functionCode <= 2 ? Math.ceil(count / 8) : count * 2;
  if (data.length !== expected) throw new ModbusError('invalid data length');
  if (functionCode <= 2) return Array.from({ length: count }, (_, i) => (data[i >> 3] >> (i & 7)) & 1);
  return Array.from({ length: count }, (_, i) => (data[i * 2] << 8) | data[i * 2 + 1]);
}

export function parseTcpResponse(frame, { transactionId, unitId, functionCode, count }) {
  if (frame.length < 9) throw new ModbusError('short TCP response');
  if (frame.readUInt16BE(0) !== transactionId) throw new ModbusError('transaction ID mismatch');
  if (frame.readUInt16BE(2) !== 0) throw new ModbusError('invalid protocol ID');
  if (frame.readUInt16BE(4) !== frame.length - 6) throw new ModbusError('TCP length mismatch');
  if (frame[6] !== unitId) throw new ModbusError('unit ID mismatch');
  if (frame[7] === (functionCode | 0x80)) {
    if (frame.length !== 9) throw new ModbusError('invalid exception response');
    throw new ModbusError(`Modbus exception ${frame[8]}`, 'exception', frame[8]);
  }
  if (frame[7] !== functionCode) throw new ModbusError('function code mismatch');
  if (frame.length !== 9 + frame[8]) throw new ModbusError('byte count mismatch');
  return decodeValues(functionCode, frame.subarray(9), count);
}
