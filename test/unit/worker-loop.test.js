import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runWorkerLoop } from '../../src/workers/loop.js';

test('a long worker iteration keeps a heartbeat without overlapping the worker loop', async () => {
  const controller = new AbortController();
  const health = { workers: {} };
  let runs = 0;
  await runWorkerLoop({
    name: 'long-worker', signal: controller.signal, health, logger: { error: () => {} }, heartbeatMs: 5,
    runOnce: async () => {
      runs += 1;
      await delay(25);
      controller.abort();
      return true;
    },
  });
  assert.equal(runs, 1);
  assert.equal(health.workers['long-worker'].state, 'STOPPED');
  assert.equal(health.workers['long-worker'].inFlight, false);
  assert.ok(health.workers['long-worker'].lastHeartbeatAt);
  assert.ok(health.workers['long-worker'].lastCompletedAt);
});

test('worker backoff resets after a successful iteration while total failures remain observable', async () => {
  const controller = new AbortController();
  const health = { workers: {} };
  const sleeps = [];
  let runs = 0;
  await runWorkerLoop({
    name: 'backoff-worker', signal: controller.signal, health, logger: { error: () => {} },
    runOnce: async () => {
      runs += 1;
      if (runs === 2) return true;
      throw new Error(`failure-${runs}`);
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      if (sleeps.length === 2) controller.abort();
    },
  });
  assert.equal(runs, 3);
  assert.deepEqual(sleeps, [500, 500]);
  assert.equal(health.workers['backoff-worker'].failures, 2);
  assert.equal(health.workers['backoff-worker'].consecutiveFailures, 1);
});
