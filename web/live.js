export function createLivePoller({ read, onUpdate = () => {}, onError = () => {} }) {
  let running = false;
  let timer = null;
  let generation = 0;
  const poller = {
    get running() { return running; },
    start(items, intervalMs = 2000) {
      if (running) throw new Error('Live กำลังทำงาน');
      if (!Array.isArray(items) || !items.length) throw new Error('เลือก address สำหรับ Live');
      if (!Number.isInteger(intervalMs) || intervalMs < 500 || intervalMs > 60000) throw new Error('ช่วงเวลา Live ต้องอยู่ระหว่าง 500–60000 ms');
      running = true;
      const current = ++generation;
      const tick = async () => {
        for (const item of items) {
          if (!running || current !== generation) return;
          try {
            const values = await read({ functionCode: item.functionCode, address: item.address, count: 1 });
            if (running && current === generation) onUpdate({ ...item, value: values[0], time: Date.now(), status: 'ok' });
          } catch (error) {
            if (running && current === generation) onError({ ...item, status: 'failed', message: error?.message || String(error), time: Date.now() });
          }
        }
        if (running && current === generation) timer = setTimeout(tick, intervalMs);
      };
      tick();
    },
    stop() {
      running = false;
      generation++;
      clearTimeout(timer);
      timer = null;
    }
  };
  return poller;
}
