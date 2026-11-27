export const AREAS = [
  { functionCode: 1, name: 'Coils', reference: '0' },
  { functionCode: 2, name: 'Discrete inputs', reference: '1' },
  { functionCode: 3, name: 'Holding registers', reference: '4' },
  { functionCode: 4, name: 'Input registers', reference: '3' }
];

export function referenceLabel(functionCode, address) {
  const prefix = AREAS.find(area => area.functionCode === functionCode)?.reference;
  return prefix === undefined ? String(address) : `${prefix}${String(address + 1).padStart(4, '0')}`;
}

export const FAST_MIN_BLOCK = 8;
export const MAX_CONSECUTIVE_FAILURES = 5;

export async function scan({ read, areas, start, end, chunkSize, minBlock = 1, maxConsecutiveFailures = MAX_CONSECUTIVE_FAILURES, signal, onProgress = () => {}, onResult = () => {} }) {
  if (!Array.isArray(areas) || !areas.length || areas.some(area => ![1, 2, 3, 4].includes(area))) throw new Error('เลือกประเภทข้อมูลอย่างน้อยหนึ่งประเภท');
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 65535 || start > end) throw new Error('ช่วง address ไม่ถูกต้อง');
  if (!Number.isInteger(minBlock) || minBlock < 1) throw new Error('minBlock ไม่ถูกต้อง');
  if (!Number.isInteger(maxConsecutiveFailures) || maxConsecutiveFailures < 1) throw new Error('maxConsecutiveFailures ไม่ถูกต้อง');
  let consecutiveFailures = 0;
  const summary = { total: (end - start + 1) * areas.length, processed: 0, readable: 0, invalid: 0, unsupported: 0, failed: 0, requests: 0, cancelled: false, stopped: false };
  const progress = () => onProgress({ ...summary });
  for (const functionCode of areas) {
    if (signal?.aborted) { summary.cancelled = true; break; }
    const size = Math.min(chunkSize || (functionCode <= 2 ? 256 : 64), functionCode <= 2 ? 2000 : 125);
    if (!Number.isInteger(size) || size < 1) throw new Error('chunkSize ไม่ถูกต้อง');
    let unsupportedArea = false;
    const areaStartProcessed = summary.processed;
    const readBlock = async (address, count) => {
      if (signal?.aborted || summary.stopped) { summary.cancelled ||= !!signal?.aborted; return; }
      summary.requests++;
      try {
        const values = await read({ functionCode, address, count, signal });
        if (signal?.aborted) { summary.cancelled = true; return; }
        if (!Array.isArray(values) || values.length !== count) throw new Error('จำนวนค่าที่ตอบกลับไม่ถูกต้อง');
        consecutiveFailures = 0;
        values.forEach((value, offset) => onResult({ status: 'ok', functionCode, address: address + offset, value, time: Date.now() }));
        summary.readable += count;
        summary.processed += count;
        progress();
      } catch (error) {
        if (signal?.aborted || error?.kind === 'cancelled') { summary.cancelled = true; return; }
        if (error?.terminal) summary.stopped = true;
        // A Modbus exception means the device answered, so only count communication failures.
        if (error?.kind === 'exception') consecutiveFailures = 0;
        else if (++consecutiveFailures >= maxConsecutiveFailures) summary.stopped = true;
        if (error?.kind === 'exception' && error.exceptionCode === 1) {
          unsupportedArea = true;
          return;
        }
        if (error?.kind === 'exception' && error.exceptionCode === 2 && count > minBlock) {
          const left = Math.floor(count / 2);
          await readBlock(address, left);
          if (!unsupportedArea && !summary.cancelled && !summary.stopped) await readBlock(address + left, count - left);
          return;
        }
        const status = error?.kind === 'exception' && error.exceptionCode === 2 ? 'invalid' : 'failed';
        summary[status] += count;
        summary.processed += count;
        onResult({ status, functionCode, address, count, message: error?.message || String(error) });
        progress();
      }
    };
    for (let address = start; address <= end; address += size) {
      await readBlock(address, Math.min(size, end - address + 1));
      if (unsupportedArea) {
        const areaProcessed = summary.processed - areaStartProcessed;
        const remaining = end - start + 1 - areaProcessed;
        summary.unsupported += remaining;
        summary.processed += remaining;
        onResult({ status: 'unsupported', functionCode, address: start + areaProcessed, count: remaining, message: 'อุปกรณ์ไม่รองรับประเภทข้อมูลนี้' });
        progress();
        break;
      }
      if (summary.cancelled || summary.stopped || signal?.aborted) { summary.cancelled ||= !!signal?.aborted; break; }
    }
    if (summary.cancelled || summary.stopped) break;
  }
  return summary;
}
