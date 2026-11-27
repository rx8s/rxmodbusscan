import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivePoller, groupLiveItems } from '../web/live.js';

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

test('groups consecutive addresses of the same type', () => {
  const items = [{ functionCode: 3, address: 11 }, { functionCode: 3, address: 10 }, { functionCode: 3, address: 13 }, { functionCode: 1, address: 11 }, { functionCode: 3, address: 12 }];
  assert.deepEqual(groupLiveItems(items).map(group => group.map(item => `${item.functionCode}:${item.address}`)), [['1:11'], ['3:10', '3:11', '3:12', '3:13']]);
  const many = Array.from({ length: 130 }, (_, address) => ({ functionCode: 4, address }));
  assert.deepEqual(groupLiveItems(many).map(group => group.length), [125, 5]);
});

test('reads a contiguous group in one request', async () => {
  const calls = [];
  const updates = [];
  let done;
  const finished = new Promise(resolve => { done = resolve; });
  const poller = createLivePoller({ read: async request => { calls.push(request); return [7, 8, 9]; }, onUpdate: row => { updates.push(row); if (updates.length === 3) done(); } });
  poller.start([{ functionCode: 3, address: 20 }, { functionCode: 3, address: 21 }, { functionCode: 3, address: 22 }], 1000);
  await finished;
  await poller.stop();
  assert.deepEqual(calls.map(({ address, count }) => [address, count]), [[20, 3]]);
  assert.deepEqual(updates.map(row => [row.address, row.value]), [[20, 7], [21, 8], [22, 9]]);
});

test('falls back to single reads when a group read gets a Modbus exception', async () => {
  const calls = [];
  const updates = [];
  let done;
  const finished = new Promise(resolve => { done = resolve; });
  const poller = createLivePoller({
    read: async ({ address, count }) => { calls.push([address, count]); if (count > 1) throw { kind: 'exception', exceptionCode: 2 }; return [address]; },
    onUpdate: row => { updates.push(row); if (updates.length === 2) done(); },
    onError: () => assert.fail('group exception should not be reported as a failure')
  });
  poller.start([{ functionCode: 3, address: 1 }, { functionCode: 3, address: 2 }], 1000);
  await finished;
  await poller.stop();
  assert.deepEqual(calls, [[1, 2], [1, 1], [2, 1]]);
});
