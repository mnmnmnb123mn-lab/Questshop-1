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
