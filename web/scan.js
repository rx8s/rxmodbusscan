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

export async function scan({ read, areas, start, end, chunkSize, signal, onProgress = () => {}, onResult = () => {} }) {
  if (!Array.isArray(areas) || !areas.length || areas.some(area => ![1, 2, 3, 4].includes(area))) throw new Error('เลือกประเภทข้อมูลอย่างน้อยหนึ่งประเภท');
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 65535 || start > end) throw new Error('ช่วง address ไม่ถูกต้อง');
  const summary = { total: (end - start + 1) * areas.length, processed: 0, readable: 0, invalid: 0, unsupported: 0, failed: 0, requests: 0, cancelled: false };
  const progress = () => onProgress({ ...summary });
  for (const functionCode of areas) {
    if (signal?.aborted) { summary.cancelled = true; break; }
    const size = Math.min(chunkSize || (functionCode <= 2 ? 256 : 64), functionCode <= 2 ? 2000 : 125);
    if (!Number.isInteger(size) || size < 1) throw new Error('chunkSize ไม่ถูกต้อง');
    let unsupportedArea = false;
    const readBlock = async (address, count) => {
      if (signal?.aborted) { summary.cancelled = true; return; }
      summary.requests++;
      try {
        const values = await read({ functionCode, address, count });
        if (!Array.isArray(values) || values.length !== count) throw new Error('จำนวนค่าที่ตอบกลับไม่ถูกต้อง');
        values.forEach((value, offset) => onResult({ status: 'ok', functionCode, address: address + offset, value, time: Date.now() }));
        summary.readable += count;
        summary.processed += count;
        progress();
      } catch (error) {
        if (error?.kind === 'exception' && error.exceptionCode === 1) {
          unsupportedArea = true;
          return;
        }
        if (error?.kind === 'exception' && error.exceptionCode === 2 && count > 1) {
          const left = Math.floor(count / 2);
          await readBlock(address, left);
          if (!unsupportedArea && !summary.cancelled) await readBlock(address + left, count - left);
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
        const remaining = end - start + 1 - (summary.processed % (end - start + 1));
        summary.unsupported += remaining;
        summary.processed += remaining;
        onResult({ status: 'unsupported', functionCode, address: start, count: end - start + 1, message: 'อุปกรณ์ไม่รองรับประเภทข้อมูลนี้' });
        progress();
        break;
      }
      if (summary.cancelled || signal?.aborted) { summary.cancelled = true; break; }
    }
    if (summary.cancelled) break;
  }
  return summary;
}
