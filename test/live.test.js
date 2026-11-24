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
  await poller.stop();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].address, 7);
  assert.equal(poller.running, false);
});

test('stop aborts a pending read before restart', async () => {
  let aborted = false;
  const poller = createLivePoller({ read: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true })) });
  poller.start([{ functionCode: 3, address: 1 }], 1000);
  await poller.stop();
  assert.equal(aborted, true);
  assert.equal(poller.running, false);
  poller.start([{ functionCode: 3, address: 2 }], 1000);
  await poller.stop();
});

test('stops automatically on terminal transport failure', async () => {
  let stopped;
  const done = new Promise(resolve => { stopped = resolve; });
  const poller = createLivePoller({ read: async () => { const error = new Error('disconnected'); error.terminal = true; throw error; }, onStopped: stopped });
  poller.start([{ functionCode: 3, address: 1 }], 1000);
  await done;
  assert.equal(poller.running, false);
});
