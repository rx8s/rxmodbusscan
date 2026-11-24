import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivePoller } from '../web/live.js';

test('polls only selected addresses and stops', async () => {
  const calls = [];
  let updated;
  const firstUpdate = new Promise(resolve => { updated = resolve; });
  const poller = createLivePoller({ read: async request => { calls.push(request); return [42]; }, onUpdate: updated });
  poller.start([{ functionCode: 3, address: 7 }], 1000);
  await firstUpdate;
  poller.stop();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].address, 7);
  assert.equal(poller.running, false);
});
