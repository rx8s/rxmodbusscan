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
      const tick = async () => {
        for (const item of items) {
          if (!running) return;
          activeController = new AbortController();
          try {
            const values = await read({ functionCode: item.functionCode, address: item.address, count: 1, signal: activeController.signal });
            if (running) onUpdate({ ...item, value: values[0], time: Date.now(), status: 'ok' });
          } catch (error) {
            if (!running) return;
            onError({ ...item, status: 'failed', message: error?.message || String(error), time: Date.now() });
            if (error?.terminal) { running = false; onStopped(error); return; }
          } finally { activeController = null; }
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
