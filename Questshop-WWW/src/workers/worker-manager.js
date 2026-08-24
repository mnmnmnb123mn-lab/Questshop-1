import { v7 as uuidv7 } from 'uuid';
import { runWorkerLoop } from './loop.js';
import { processPayment } from './payment-worker.js';
import { processOutbox } from './outbox-worker.js';
import {
  acquireRunnableJob, processRunnerJob, renewRunnerJob, requeueDueRunnerJobs,
} from '../domain/runner/service.js';
import { setTimeout as delay } from 'node:timers/promises';
import { runMaintenance } from './maintenance-worker.js';
import { createContext } from '../shared/correlation.js';
import { scanMonitor } from './discovery-worker.js';
import { testQuest } from './quest-test-worker.js';
import { runScheduledBackup } from './backup-worker.js';
import { runRetention } from './retention-worker.js';
import { rotateEncryptedRows } from './key-rotation-worker.js';
import { evaluateAlerts } from './alert-worker.js';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { usesApplicationBackup } from '../config/env.js';
import { reconcileIncident } from '../domain/incidents/service.js';
import { reconcileSurfaceAnchors } from '../discord/surfaces/setup.js';
import { APPLICATION_EVENTS, applicationEvents } from '../shared/application-events.js';
import { safeError } from '../shared/redaction.js';

async function gate(pool, name) {
  return (await pool.query('SELECT enabled FROM feature_gates WHERE gate = $1', [name])).rows[0]?.enabled === true;
}

function configuredRunnerConcurrency(client, env) {
  return Math.max(1, Math.min(env.RUNNER_CONCURRENCY_HARD_MAX,
    Number(client.questshop.config.values?.runnerConcurrency ?? env.RUNNER_CONCURRENCY)));
}

export function installQuestPriceSurfaceRefresh({
  client,
  pool,
  env,
  signal,
  logger,
  reconcile = reconcileSurfaceAnchors,
}) {
  let pending = Promise.resolve();
  let sequence = 0;
  const onQuestPriceChanged = (event = {}) => {
    if (signal?.aborted) return;
    const traceId = event.traceId ?? uuidv7();
    sequence += 1;
    const refreshSequence = sequence;
    pending = pending.then(async () => {
      if (signal?.aborted) return;
      const context = createContext({
        traceId,
        actorType: 'SYSTEM',
        actorId: 'price-surface-refresh',
        guildId: env.DISCORD_GUILD_ID,
        idempotencyKey: `quest-price-surface-refresh:${traceId}:${refreshSequence}`,
      });
      const results = await reconcile({ client, pool, env, config: client.questshop?.config }, context);
      const storefront = results.find((result) => result.surfaceKey === 'QUEST_AUTO');
      if (storefront?.reconciled === false) {
        logger?.warn?.({ traceId, reason: storefront.reason },
          'Quest Auto price refresh deferred to maintenance');
      }
    }).catch((error) => {
      logger?.warn?.({ error: safeError(error), traceId },
        'Quest Auto price refresh deferred to maintenance');
    });
  };
  applicationEvents.on(APPLICATION_EVENTS.QUEST_CATEGORY_PRICE_CHANGED, onQuestPriceChanged);
  return {
    flush: () => pending,
    dispose: () => applicationEvents.off(APPLICATION_EVENTS.QUEST_CATEGORY_PRICE_CHANGED, onQuestPriceChanged),
  };
}

export function startWorkers({ client, pool, env, signal, health, logger, startDeferred = true }) {
  const tasks = [];
  const priceSurfaceRefresh = installQuestPriceSurfaceRefresh({ client, pool, env, signal, logger });
  const eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
  eventLoopMonitor.enable();
  const recordIteration = async ({ name, error, durationMs }) => {
    await pool.query(`INSERT INTO operation_metrics(id,operation,outcome,duration_ms,error_class)
      VALUES($1,$2,$3,$4,$5)`, [uuidv7(), `WORKER:${name}`, error ? 'ERROR' : 'SUCCESS',
      Math.max(0, durationMs), error?.category ?? error?.code ?? error?.name ?? null]);
    if (error?.code === 'SECRET_DECRYPT_FAILED') {
      const context = createContext({ actorType: 'SYSTEM', actorId: 'worker-manager', guildId: env.DISCORD_GUILD_ID,
        idempotencyKey: `worker-secret-decrypt:${name}` });
      await reconcileIncident({ code: 'SECRET_DECRYPT_FAILED', scope: 'CRYPTO', active: true,
        severity: 'CRITICAL', evidence: { worker: name } }, context, { pool });
    }
  };
  const start = (name, runOnce, idleMs) => tasks.push(runWorkerLoop({ name, signal, health, logger,
    runOnce, idleMs, onIteration: recordIteration }));
  let nextRunnerRequeueAt = 0;
  start('readiness', async () => {
    try {
      await pool.query('SELECT 1');
      health.checks.database = 'OK';
      health.checks.discord = client.isReady() ? 'OK' : 'NOT_READY';
      const ready = client.isReady() && health.checks.schema === 'OK'
        && health.checks.runtimeLease === 'OK' && health.checks.config === 'OK' && health.checks.bootstrap === 'READY'
        && health.checks.keyrings === 'OK';
      health.ready = ready;
      if (ready) health.lastError = null;
      if (!ready) health.status = 'NOT_READY';
      else if (health.status === 'NOT_READY') health.status = 'HEALTHY';
      return false;
    } catch (error) {
      health.ready = false; health.status = 'NOT_READY';
      health.checks.database = 'FAILED'; health.lastError = error;
      throw error;
    }
  }, 5_000);
  start('outbox-1', async () => (await gate(pool, 'NOTIFICATIONS_ENABLED'))
    && processOutbox({ holder: uuidv7(), client, pool, env }), 250);
  start('outbox-2', async () => (await gate(pool, 'NOTIFICATIONS_ENABLED'))
    && processOutbox({ holder: uuidv7(), client, pool, env }), 250);
  let deferredStarted = false;
  const startDeferredWorkers = () => {
    if (deferredStarted) return;
    deferredStarted = true;
    start('payment', async () => processPayment({ holder: uuidv7(), env, signal, pool,
      autoCredit: await gate(pool, 'AUTO_CREDIT_ENABLED') }), 500);
    for (let index = 0; index < env.RUNNER_CONCURRENCY_HARD_MAX; index += 1) {
      const holder = uuidv7();
      start(`runner-${index + 1}`, async () => {
        if (!(await gate(pool, 'RUNNER_DISPATCH_ENABLED'))) return false;
        const effectiveConcurrency = configuredRunnerConcurrency(client, env);
        if (index >= effectiveConcurrency) return false;
        const acquisitionContext = createContext({ actorType: 'SYSTEM', actorId: holder,
          guildId: env.DISCORD_GUILD_ID, idempotencyKey: `runner-acquire:${uuidv7()}` });
        // Recovery is durable and also runs in maintenance. Avoid making every
        // idle runner slot take a locking requeue transaction four times/sec.
        if (Date.now() >= nextRunnerRequeueAt) {
          nextRunnerRequeueAt = Date.now() + 5_000;
          await requeueDueRunnerJobs(acquisitionContext, { pool });
        }
        const job = await acquireRunnableJob({ holder }, acquisitionContext, { pool });
        if (!job) return false;
        const leaseAbort = new AbortController();
        const jobSignal = AbortSignal.any([signal, leaseAbort.signal]);
        const heartbeat = (async () => {
          while (!jobSignal.aborted) {
            await delay(15_000, undefined, { signal: jobSignal, ref: false });
            if (jobSignal.aborted) break;
            try { await renewRunnerJob(job, 60, { pool }); }
            catch (error) { leaseAbort.abort(error); break; }
          }
        })().catch(() => {});
        try {
          await processRunnerJob(job, {
            env: { ...env, RUNNER_CONCURRENCY: effectiveConcurrency }, signal: jobSignal, options: { pool },
          });
        }
        finally { leaseAbort.abort('runner finished'); await heartbeat; }
        return true;
      }, 250);
    }
    const maintenanceHolder = uuidv7();
    const scannerHolder = uuidv7();
    start('scanner', async () => (await gate(pool, 'QUEST_SCANNER_ENABLED'))
      && scanMonitor({ env, pool, signal, holder: scannerHolder,
        runnerConcurrency: configuredRunnerConcurrency(client, env) }), 60_000);
    const testHolder = uuidv7();
    start('quest-test', async () => (await gate(pool, 'QUEST_BACKGROUND_TESTING_ENABLED'))
      && testQuest({ env, pool, signal, holder: testHolder,
        runnerConcurrency: configuredRunnerConcurrency(client, env) }), 1_000);
    if (usesApplicationBackup(env)) start('backup', () => runScheduledBackup({ env, pool }), 60_000);
    start('retention', () => runRetention({ pool }), 60_000);
    start('key-rotation', async () => (await rotateEncryptedRows({ pool, env })) > 0, 60_000);
    start('alerts', () => evaluateAlerts({ env, pool, health, eventLoopMonitor }), 60_000);
    start('maintenance', async () => {
      await runMaintenance({ env, holder: maintenanceHolder, client, pool,
        runnerConcurrency: configuredRunnerConcurrency(client, env) });
      return false;
    }, 60_000);
  };
  if (startDeferred) startDeferredWorkers();
  return { tasks, startDeferred: startDeferredWorkers, stop: async () => {
    priceSurfaceRefresh.dispose();
    const results = await Promise.allSettled(tasks);
    await priceSurfaceRefresh.flush();
    eventLoopMonitor.disable();
    return results;
  } };
}
