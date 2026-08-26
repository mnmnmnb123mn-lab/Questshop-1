import { setTimeout as delay } from 'node:timers/promises';
import { v7 as uuidv7 } from 'uuid';
import { closeHealthServer } from './health-server.js';
import { closePools } from '../db/pools.js';
import { releaseLease } from '../db/leases.js';
import { processOutbox } from '../workers/outbox-worker.js';

function remaining(deadline) { return Math.max(0, deadline - Date.now()); }
async function bounded(promise, deadline, label) {
  const timeout = remaining(deadline);
  if (!timeout) throw new Error(`shutdown deadline exceeded before ${label}`);
  const marker = Symbol(label);
  const result = await Promise.race([promise, delay(timeout, marker, { ref: false })]);
  if (result === marker) throw new Error(`shutdown deadline exceeded during ${label}`);
  return result;
}

async function flushOutbox(runtime, deadline) {
  const flushDeadline = Math.min(deadline, Date.now() + 15_000);
  while (Date.now() < flushDeadline) {
    const pending = Number((await runtime.pool.query(`SELECT count(*)::integer AS count FROM outbox_events
      WHERE state IN ('PENDING','RETRY_WAIT') AND available_at<=clock_timestamp()`)).rows[0].count);
    if (!pending) return;
    const delivered = await processOutbox({ holder: uuidv7(), client: runtime.client,
      pool: runtime.pool, env: runtime.env });
    if (!delivered) await delay(100, undefined, { ref: false });
  }
}

async function preserveCleanupFailure(action, failure) {
  try {
    await action();
  } catch (error) {
    return failure ?? error;
  }
  return failure;
}

export function shutdown(runtime, reason = 'shutdown', { leaseLost = false, error = null } = {}) {
  if (runtime.shutdownPromise) return runtime.shutdownPromise;
  let resolve;
  let reject;
  runtime.shutdownPromise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // Install the promise before abort() can synchronously trigger a listener
  // that calls shutdown again.
  void Promise.resolve().then(() => shutdownOnce(runtime, reason, { leaseLost, error })).then(resolve, reject);
  return runtime.shutdownPromise;
}

async function shutdownOnce(runtime, reason, { leaseLost, error }) {
  const deadline = Date.now() + 25_000;
  runtime.acceptingInteractions = false;
  runtime.health.ready = false;
  runtime.health.status = leaseLost ? 'INCIDENT' : 'NOT_READY';
  if (error) runtime.health.lastError = error;
  runtime.abortController.abort(reason);
  // A process that lost the Runtime lease must stop Discord ingress before any
  // drain work.  It no longer has authority to publish customer-facing state.
  let failure = null;
  if (leaseLost) {
    failure = await preserveCleanupFailure(async () => runtime.client?.destroy?.(), failure);
  }
  try {
    await bounded(Promise.resolve(runtime.workers?.stop?.()), Math.min(deadline, Date.now() + 10_000), 'worker checkpoint');
    if (!leaseLost) await bounded(flushOutbox(runtime, deadline), deadline, 'outbox flush');
    await bounded(Promise.resolve(runtime.heartbeat).catch(() => null), deadline, 'runtime heartbeat');
    if (!leaseLost) {
      await bounded(releaseLease({ resourceType: 'RUNTIME', resourceId: runtime.env.DISCORD_GUILD_ID,
        holder: runtime.runtimeHolder, fencingToken: runtime.runtimeLease.fencing_token }, { pool: runtime.pool }).catch(() => null),
      deadline, 'runtime lease release');
    }
  } catch (error_) { failure ??= error_; }
  if (!leaseLost) {
    failure = await preserveCleanupFailure(async () => runtime.client?.destroy?.(), failure);
  }
  await bounded(closePools().catch(() => null), deadline, 'database close').catch((error_) => { failure ??= error_; });
  runtime.health.live = false;
  await bounded(closeHealthServer(runtime.server).catch(() => null), deadline, 'health close')
    .catch((error) => { failure ??= error; });
  if (failure) throw failure;
}
