export const MAX_GROUP = { bits: 2000, registers: 125 };

// Groups items with the same function code and consecutive addresses so one request reads them all.
export function groupLiveItems(items) {
  const sorted = [...items].sort((a, b) => a.functionCode - b.functionCode || a.address - b.address);
  const groups = [];
  for (const item of sorted) {
    const group = groups.at(-1);
    const last = group?.at(-1);
    const limit = item.functionCode <= 2 ? MAX_GROUP.bits : MAX_GROUP.registers;
    if (last && last.functionCode === item.functionCode && last.address + 1 === item.address && group.length < limit) group.push(item);
    else if (!last || last.functionCode !== item.functionCode || last.address !== item.address) groups.push([item]);
  }
  return groups;
}

export function createLivePoller({ read, onUpdate = () => {}, onError = () => {}, onStopped = () => {} }) {
  let running = false;
  let timer = null;
  let activeController = null;
  let task = null;
  const poller = {
    get running() { return running; },
    start(items, intervalMs = 2000) {
      if (running || task) throw new Error('Live กำลังทำงานหรือกำลังหยุด');
      if (!Array.isArray(items) || !items.length) throw new Error('เลือก address สำหรับ Live');
      if (!Number.isInteger(intervalMs) || intervalMs < 500 || intervalMs > 60000) throw new Error('ช่วงเวลา Live ต้องอยู่ระหว่าง 500–60000 ms');
      running = true;
      const groups = groupLiveItems(items);
      // Returns false when polling must stop.
      const readGroup = async group => {
        activeController = new AbortController();
        try {
          const values = await read({ functionCode: group[0].functionCode, address: group[0].address, count: group.length, signal: activeController.signal });
          if (!running) return false;
          const time = Date.now();
          group.forEach((item, i) => onUpdate({ ...item, value: values[i], time, status: 'ok' }));
          return true;
        } catch (error) {
          if (!running) return false;
          if (error?.kind === 'exception' && group.length > 1) return 'split';
          const time = Date.now();
          group.forEach(item => onError({ ...item, status: 'failed', message: error?.message || String(error), time }));
          if (error?.terminal) { running = false; onStopped(error); return false; }
          return true;
        } finally { activeController = null; }
      };
      const tick = async () => {
        for (let i = 0; i < groups.length; i++) {
          if (!running) return;
          const result = await readGroup(groups[i]);
          if (result === false) return;
          if (result === 'split') {
            // Some devices reject multi-register reads across internal block boundaries; read these one by one from now on.
            groups.splice(i, 1, ...groups[i].map(item => [item]));
            i--;
          }
        }
        if (running) timer = setTimeout(() => { task = tick().finally(() => { task = null; }); }, intervalMs);
      };
      task = tick().finally(() => { task = null; });
    },
    async stop() {
      running = false;
      clearTimeout(timer);
      timer = null;
      activeController?.abort();
      if (task) await task;
    }
  };
  return poller;
}
