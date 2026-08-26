import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { v7 as uuidv7 } from 'uuid';
import { Events } from 'discord.js';
import { loadRuntimeEnvironment } from '../config/env.js';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import { closePools, getRuntimePool, observePoolErrors } from '../db/pools.js';
import { validateMigrationChecksums, validateSchemaCompatibility } from '../db/migrations.js';
import { acquireLease, renewLease } from '../db/leases.js';
import { FencingLostError } from '../shared/errors.js';
import { createDiscordClient } from '../discord/client.js';
import { routeInteraction } from '../discord/interactions/router.js';
import { startWorkers } from '../workers/worker-manager.js';
import { closeHealthServer, createHealthState, startHealthServer } from './health-server.js';
import { createLogger } from '../shared/logger.js';
import { runMaintenance } from '../workers/maintenance-worker.js';
import { validateKeyringCoverage } from './keyring-coverage.js';
import { validateKeyringSentinels } from './keyring-sentinels.js';
import { validateRuntimeRole } from '../db/role-contract.js';
import { processOutbox } from '../workers/outbox-worker.js';
import { verifyConfiguredSourceSha } from '../config/source-version.js';
import { reconcileIncident } from '../domain/incidents/service.js';
import { recomputeHealthStatus } from './health-status.js';

export async function openRuntimeDatabase(env, health, dependencies = {}) {
  const pool = (dependencies.getRuntimePool ?? getRuntimePool)(env);
  const observeErrors = dependencies.observePoolErrors ?? observePoolErrors;
  // The pool itself owns the event listener. Startup only projects it into
  // readiness; it must never try to repair grants or restart work from an
  // asynchronous idle-client error.
  try {
    observeErrors(pool, (error) => {
      health.checks.database = 'DEGRADED';
      health.status = recomputeHealthStatus({ health });
      health.lastError = error;
    });
  } catch (error) {
    if (dependencies.observePoolErrors) throw error;
  }
  await pool.query('SELECT 1');
  await (dependencies.validateSchemaCompatibility ?? validateSchemaCompatibility)(pool);
  await (dependencies.validateMigrationChecksums ?? validateMigrationChecksums)(pool);
  health.checks.schema = 'OK';
  await (dependencies.validateKeyringCoverage ?? validateKeyringCoverage)(pool, env);
  await (dependencies.validateKeyringSentinels ?? validateKeyringSentinels)(pool, env);
  health.checks.keyrings = 'OK';
  const roleContract = await (dependencies.validateRuntimeRole ?? validateRuntimeRole)(pool, {
    enforce: env.NODE_ENV === 'production',
  });
  health.checks.runtimeRole = roleContract.violations.length ? 'DEGRADED' : 'OK';
  health.checks.database = 'OK';
  return pool;
}

export async function validatePaymentReadiness(pool, health) {
  const [gateResult, receiverResult] = await Promise.all([
    pool.query(`SELECT gate,enabled FROM feature_gates
      WHERE gate IN ('TOPUP_ACCEPTING','AUTO_CREDIT_ENABLED')`),
    pool.query("SELECT id FROM receiver_versions WHERE state='ACTIVE' LIMIT 1"),
  ]);
  const gates = new Map(gateResult.rows.map((row) => [row.gate, row.enabled === true]));
  const paymentEnabled = gates.get('TOPUP_ACCEPTING') || gates.get('AUTO_CREDIT_ENABLED');
  const hasReceiver = receiverResult.rowCount > 0;
  if (paymentEnabled && !hasReceiver) {
    health.checks.payments = 'MISSING_RECEIVER';
    // A new store intentionally has no receiver yet. Keep the backoffice
    // available so the Owner can add one; submitVoucher still refuses intake
    // without a snapshot, and worker processing cannot redeem a new voucher.
    return { paymentEnabled, hasReceiver, ready: false };
  }
  health.checks.payments = hasReceiver ? 'OK' : 'DISABLED';
  return { paymentEnabled, hasReceiver, ready: hasReceiver || !paymentEnabled };
}

async function acquireRuntimeOwnership(pool, env, health) {
  const holder = uuidv7();
  const runtimeLease = await acquireLease({ resourceType: 'RUNTIME', resourceId: env.DISCORD_GUILD_ID, holder, ttlSeconds: 60 }, { pool });
  if (!runtimeLease) throw new Error('Another Questshop runtime holds the production guild lease');
  health.checks.runtimeLease = 'OK';
  return { holder, runtimeLease };
}

export async function waitForDiscordReady(client) {
  if (!client.isReady()) await once(client, Events.ClientReady);
}

export async function connectDiscord(env, logger, health, runtime, dependencies = {}) {
  const client = (dependencies.createDiscordClient ?? createDiscordClient)();
  client.questshop = runtime;
  client.on('interactionCreate', dependencies.routeInteraction ?? routeInteraction);
  client.on('error', (error) => logger.error({ error }, 'discord client error'));
  try {
    await client.login(env.DISCORD_BOT_TOKEN);
    await waitForDiscordReady(client);
    const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID);
    const me = await guild.members.fetchMe();
    if (!me.permissions.has('Administrator')) {
      throw Object.assign(new Error('Questshop bot must have Discord Administrator permission'), {
        code: 'DISCORD_ADMINISTRATOR_REQUIRED',
      });
    }
    health.checks.discord = 'OK';
    return client;
  } catch (error) {
    // The outer startup cleanup receives a client only after this function
    // returns, so this is the sole owner for failures after Discord login.
    await Promise.resolve(client.destroy?.()).catch(() => null);
    throw error;
  }
}

function isRuntimeLeaseLost(error) {
  return error instanceof FencingLostError || error?.code === 'FENCING_LOST';
}

async function waitForRuntimeLeaseRetry({ abortController, attempt, wait }) {
  try {
    await wait(1_000 * (2 ** attempt), undefined, { signal: abortController.signal, ref: false });
    return !abortController.signal.aborted;
  } catch (error) {
    if (abortController.signal.aborted || error?.name === 'AbortError') return false;
    throw error;
  }
}

function runtimeLeaseRenewalInput({ env, holder, lease }) {
  return {
    resourceType: 'RUNTIME', resourceId: env.DISCORD_GUILD_ID,
    holder, fencingToken: lease.fencing_token, ttlSeconds: 60,
  };
}

export async function renewRuntimeLease({ abortController, env, holder, pool, lease, renew = renewLease, wait = delay }) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await renew(runtimeLeaseRenewalInput({ env, holder, lease }), { pool });
    } catch (error) {
      if (isRuntimeLeaseLost(error)) throw error;
      if (abortController.signal.aborted) return null;
      lastError = error;
      if (attempt < 2 && !await waitForRuntimeLeaseRetry({ abortController, attempt, wait })) {
        return null;
      }
    }
  }
  throw lastError;
}

export function startRuntimeHeartbeat({ abortController, env, holder, pool, runtimeLease, health, logger, onRuntimeLeaseLost,
  renew = renewLease, wait = delay }) {
  return (async () => {
    let lease = runtimeLease;
    while (!abortController.signal.aborted) {
      await wait(15_000, undefined, { signal: abortController.signal, ref: false });
      if (abortController.signal.aborted) break;
      try {
        const renewed = await renewRuntimeLease({ abortController, env, holder, pool, lease, renew, wait });
        if (!renewed) break;
        lease = renewed;
      } catch (error) {
        health.ready = false; health.operationalStatus = 'INCIDENT';
        health.status = recomputeHealthStatus({ health }); health.lastError = error;
        abortController.abort(error);
        Promise.resolve(onRuntimeLeaseLost?.(error)).catch((callbackError) => {
          logger.error({ error: callbackError }, 'runtime lease-loss shutdown failed');
        });
        break;
      }
    }
  })().catch((error) => { if (error?.name !== 'AbortError') throw error; });
}

function resolveBootstrapPort(rawPort) {
  if (!/^\d+$/.test(rawPort ?? '')) return 3000;
  const port = Number(rawPort);
  return port >= 1 && port <= 65535 ? port : 3000;
}

async function startRecoveredWorkers({ abortController, client, env, health, logger, pool }) {
  const workers = startWorkers({ client, pool, env, signal: abortController.signal, health, logger,
    startDeferred: false });
  const notificationsEnabled = (await pool.query("SELECT enabled FROM feature_gates WHERE gate='NOTIFICATIONS_ENABLED'"))
    .rows[0]?.enabled === true;
  if (notificationsEnabled) await processOutbox({ holder: uuidv7(), client, pool, env });
  workers.startDeferred();
  return workers;
}

async function markRuntimeReady({ env, health, logger, pool }) {
  const storeOpen = (await pool.query("SELECT enabled FROM feature_gates WHERE gate='STORE_OPEN'"))
    .rows[0]?.enabled === true;
  health.checks.bootstrap = 'READY';
  health.ready = true;
  health.operationalStatus = storeOpen ? 'HEALTHY' : 'MAINTENANCE';
  health.status = recomputeHealthStatus({ health });
  logger.info({ guildId: env.DISCORD_GUILD_ID }, 'Questshop ready');
}

async function recordStartupCryptoIncident(pool, error) {
  if (!pool || error?.code !== 'SECRET_DECRYPT_FAILED') return;
  await reconcileIncident({ code: 'SECRET_DECRYPT_FAILED', scope: 'CRYPTO', active: true,
    severity: 'CRITICAL', evidence: { phase: 'startup' } }, {
    traceId: uuidv7(), causationId: null, actorType: 'SYSTEM', actorId: 'startup', guildId: 'SYSTEM',
    idempotencyKey: 'startup-secret-decrypt',
  }, { pool }).catch(() => null);
}

async function cleanupFailedStartup({ abortController, client, error, health, heartbeat, logger, pool, server }) {
  health.lastError = error;
  health.status = 'NOT_READY';
  logger.error({ error }, 'Questshop startup failed');
  await recordStartupCryptoIncident(pool, error);
  abortController.abort(error);
  await Promise.resolve(heartbeat).catch((heartbeatError) => {
    logger.error({ error: heartbeatError }, 'runtime heartbeat cleanup after failed startup failed');
  });
  await Promise.resolve(client?.destroy?.()).catch((destroyError) => {
    logger.error({ error: destroyError }, 'discord cleanup after failed startup failed');
  });
  await closePools().catch(() => null);
  health.live = false;
  await closeHealthServer(server).catch(() => null);
}

export async function startup({ health = createHealthState(), server: existingServer = null,
  onRuntimeLeaseLost = null, onRuntimePrepared = null, signal: startupSignal = null } = {}) {
  const bootstrapPort = resolveBootstrapPort(process.env.PORT);
  const logger = createLogger({ gitSha: 'untracked' });
  const server = existingServer ?? await startHealthServer({ port: bootstrapPort,
    statusToken: process.env.STATUS_TOKEN ?? 'unconfigured', state: health });
  const abortController = new AbortController();
  if (startupSignal) {
    if (startupSignal.aborted) abortController.abort(startupSignal.reason);
    else startupSignal.addEventListener('abort', () => abortController.abort(startupSignal.reason), { once: true });
  }
  const assertStarting = () => {
    if (abortController.signal.aborted) {
      throw Object.assign(new Error('Questshop startup interrupted'), { code: 'STARTUP_ABORTED', cause: abortController.signal.reason });
    }
  };
  let client;
  let pool;
  let runtime;
  try {
    const env = loadRuntimeEnvironment();
    const source = verifyConfiguredSourceSha(env);
    health.checks.config = 'OK';
    assertStarting();
    pool = await openRuntimeDatabase(env, health);
    assertStarting();
    const { holder, runtimeLease } = await acquireRuntimeOwnership(pool, env, health);
    assertStarting();
    const config = await loadRuntimeConfig(pool);
    await validatePaymentReadiness(pool, health);
    health.checks.bootstrap = 'RECOVERING';
    runtime = { env, logger, health, server, pool, client: null, config, workers: null, abortController,
      heartbeat: null, runtimeLease, runtimeHolder: holder, acceptingInteractions: false, shutdownPromise: null };
    health.checks.sourceSha = source.verified ? 'OK' : 'UNVERIFIED';
    logger.info({ sourceSha: source.sourceSha, sourceShaVerified: source.verified },
      'Questshop source revision');
    // A lease acquired before Discord login must remain owned during recovery.
    // Components observe this same object and remain closed until Ready.
    runtime.heartbeat = startRuntimeHeartbeat({ abortController, env, holder, pool, runtimeLease,
      health, logger, onRuntimeLeaseLost });
    client = await connectDiscord(env, logger, health, runtime);
    runtime.client = client;
    assertStarting();
    await runMaintenance({ env, holder: 'startup-recovery', client, pool,
      runnerConcurrency: Number(config.values?.runnerConcurrency ?? env.RUNNER_CONCURRENCY) });
    health.checks.discord = 'OK';
    const workers = await startRecoveredWorkers({ abortController, client, env, health, logger, pool });
    assertStarting();
    runtime.workers = workers;
    await onRuntimePrepared?.(runtime);
    assertStarting();
    await markRuntimeReady({ env, health, logger, pool });
    runtime.acceptingInteractions = true;
    return runtime;
  } catch (error) {
    await cleanupFailedStartup({ abortController, client, error, health, heartbeat: runtime?.heartbeat,
      logger, pool, server });
    throw error;
  }
}
