import { readFile } from 'node:fs/promises';
import { v7 as uuidv7 } from 'uuid';
import { RUNNER_VERSION_COMPATIBILITY, isRunnerVersionCompatible } from '../config/versions.js';
import { usesApplicationBackup } from '../config/env.js';
import { reconcileIncident } from '../domain/incidents/service.js';
import { escalateStuckRedeemedTopups } from '../domain/payments/service.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

async function memoryLimitBytes() {
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const value = (await readFile(path, 'utf8')).trim();
      if (value !== 'max' && /^\d+$/.test(value)) {
        const bytes = Number(value);
        if (Number.isSafeInteger(bytes) && bytes > 0 && bytes < 2 ** 50) return bytes;
      }
    } catch { /* try the next cgroup layout */ }
  }
  return null;
}

function alertContext(code = 'cycle') {
  return {
    traceId: uuidv7(), causationId: null, actorType: 'SYSTEM', actorId: 'alert-worker',
    guildId: 'SYSTEM', idempotencyKey: `alert:${code}:${Math.floor(Date.now() / 60_000)}`,
  };
}

async function setIncident(client, { code, scope, active, severity, evidence }) {
  return reconcileIncident({ code, scope, active, severity, evidence }, {
    traceId: uuidv7(), causationId: null, actorType: 'SYSTEM', actorId: 'alert-worker',
    guildId: 'SYSTEM', idempotencyKey: `alert:${code}:${scope}`,
  }, { pool: client });
}

async function collectRuntimeMetrics(pool, eventLoopMonitor) {
  const rssBytes = process.memoryUsage().rss;
  const memoryLimit = await memoryLimitBytes();
  const memoryPercent = memoryLimit ? (rssBytes / memoryLimit) * 100 : null;
  const eventLoopLagMs = eventLoopMonitor ? eventLoopMonitor.percentile(99) / 1e6 : null;
  eventLoopMonitor?.reset();
  const memoryOutcome = memoryPercent != null && memoryPercent > 85 ? 'ERROR' : 'SUCCESS';
  const lagOutcome = eventLoopLagMs != null && eventLoopLagMs > 500 ? 'ERROR' : 'SUCCESS';
  await pool.query(`INSERT INTO operation_metrics(id,operation,outcome,duration_ms,error_class)
    VALUES($1,'SYSTEM:MEMORY_PERCENT',$2,$3,NULL),($4,'SYSTEM:EVENT_LOOP_LAG',$5,$6,NULL)`,
  [uuidv7(), memoryOutcome, Math.round(Math.max(0, memoryPercent ?? 0)), uuidv7(), lagOutcome,
    Math.round(Math.max(0, eventLoopLagMs ?? 0))]);
  return { rssBytes, memoryLimit, memoryPercent, eventLoopLagMs };
}

async function collectAlertSnapshot(pool, { applicationBackupEnabled }) {
  const noApplicationBackupQuery = Promise.resolve({ rows: [] });
  const [backupResult, restoreResult, backupCorruptionResult, restoreFailureResult] = applicationBackupEnabled
    ? [
      pool.query("SELECT EXTRACT(EPOCH FROM clock_timestamp()-completed_at)*1000 AS age_ms FROM backup_runs WHERE state='VERIFIED' ORDER BY completed_at DESC LIMIT 1"),
      pool.query("SELECT EXTRACT(EPOCH FROM clock_timestamp()-completed_at)*1000 AS age_ms FROM restore_drills WHERE state='VERIFIED' ORDER BY completed_at DESC LIMIT 1"),
      pool.query(`SELECT count(*)::integer AS count FROM backup_runs WHERE state='FAILED'
        AND error_code~*'(checksum|auth|corrupt)' AND completed_at>=clock_timestamp()-interval '30 days'`),
      pool.query(`SELECT count(*)::integer AS count FROM restore_drills WHERE state='FAILED'
        AND completed_at>=clock_timestamp()-interval '35 days'`),
    ]
    : [noApplicationBackupQuery, noApplicationBackupQuery, noApplicationBackupQuery, noApplicationBackupQuery];
  const [financial, payment, queue, scheduler, outbox, errors, backup, restore, backupCorruption, restoreFailure,
    counts, gates, activeVersions, slo] = await Promise.all([
    pool.query(`SELECT (SELECT count(*)::integer FROM wallets WHERE available_cents<0 OR reserved_cents<0) AS negative,
      (SELECT count(*)::integer FROM wallets w LEFT JOIN LATERAL (SELECT available_after_cents,reserved_after_cents
        FROM wallet_transactions t WHERE t.discord_user_id=w.discord_user_id ORDER BY created_at DESC,id DESC LIMIT 1) t ON true
        LEFT JOIN LATERAL (SELECT available_cents,reserved_cents FROM wallet_checkpoints c WHERE c.discord_user_id=w.discord_user_id
          ORDER BY c.created_at DESC LIMIT 1) c ON true WHERE COALESCE(t.available_after_cents,c.available_cents,w.available_cents)<>w.available_cents
          OR COALESCE(t.reserved_after_cents,c.reserved_cents,w.reserved_cents)<>w.reserved_cents) AS mismatch,
      (SELECT count(*)::integer FROM topups WHERE status IN ('AMBIGUOUS','MANUAL_REVIEW')) AS ambiguous,
      (SELECT count(*)::integer FROM dead_letter_items d WHERE d.state='DEAD_LETTER' AND d.category IN ('FINANCIAL','AUDIT')) AS financial_dlq,
      (SELECT count(*)::integer FROM (SELECT reference_id FROM wallet_transactions
        WHERE reference_type='TOPUP' AND transaction_type='TOPUP_CREDIT'
        GROUP BY reference_id HAVING count(*)>1) duplicate_credits) AS duplicate_credit`),
    pool.query(`SELECT
      count(*) FILTER (WHERE status='REDEEMED' AND redeemed_at<clock_timestamp()-interval '2 minutes')::integer AS redeemed_stuck,
      count(*) FILTER (WHERE status IN ('PAYMENT_QUEUED','RETRY_WAIT')
        AND updated_at<clock_timestamp()-interval '5 minutes')::integer AS queue_stuck
      FROM topups`),
    pool.query(`SELECT count(*)::integer AS stuck FROM runner_jobs WHERE state NOT IN ('COMPLETED','FAILED')
      AND updated_at<clock_timestamp()-interval '5 minutes'`),
    pool.query(`SELECT COALESCE(max(EXTRACT(EPOCH FROM clock_timestamp()-available_at)*1000),0)::bigint AS lag_ms,
      count(*)::integer AS queued FROM runner_jobs
      WHERE state='QUEUED' AND available_at<=clock_timestamp()`),
    pool.query(`SELECT count(*) FILTER (WHERE state IN ('PENDING','LEASED','RETRY_WAIT')
        AND GREATEST(created_at,available_at)<clock_timestamp()-interval '5 minutes')::integer AS stuck,
      COALESCE(max(EXTRACT(EPOCH FROM clock_timestamp()-GREATEST(created_at,available_at))*1000)
        FILTER (WHERE state IN ('PENDING','LEASED','RETRY_WAIT')),0)::bigint AS oldest_age_ms,
      count(*) FILTER (WHERE state='PENDING')::integer AS pending,
      count(*) FILTER (WHERE state='LEASED')::integer AS leased,
      count(*) FILTER (WHERE state='RETRY_WAIT')::integer AS retry_wait
      FROM outbox_events`),
    pool.query(`SELECT count(*)::integer AS total,count(*) FILTER (WHERE outcome='ERROR')::integer AS failed
      FROM operation_metrics WHERE operation IN ('PANEL_REQUEST','CUSTOMER_INTERACTION')
        AND outcome IN ('SUCCESS','ERROR') AND created_at>=clock_timestamp()-interval '5 minutes'`),
    backupResult, restoreResult, backupCorruptionResult, restoreFailureResult,
    pool.query(`SELECT (SELECT count(*)::integer FROM runner_jobs WHERE state NOT IN ('COMPLETED','FAILED')) AS queue,
      (SELECT count(*)::integer FROM outbox_events WHERE state IN ('PENDING','LEASED','RETRY_WAIT')) AS outbox,
      (SELECT count(*)::integer FROM manual_reviews WHERE state<>'RESOLVED') AS reviews,
      (SELECT count(*)::integer FROM incidents WHERE state<>'RESOLVED') AS incidents,
      (SELECT enabled FROM feature_gates WHERE gate='STORE_OPEN') AS store_open`),
    pool.query('SELECT gate,enabled,version FROM feature_gates ORDER BY gate'),
    pool.query(`SELECT DISTINCT engine_version,executor_version,contract_version,runner_state_schema_version
      FROM runner_jobs WHERE state NOT IN ('COMPLETED','FAILED')`),
    pool.query(`SELECT
      percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE operation='INTERACTION_ACK'
        AND created_at>=clock_timestamp()-interval '5 minutes') AS interaction_ack_p95,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE operation='INTERACTION_ACK'
        AND created_at>=clock_timestamp()-interval '5 minutes') AS interaction_ack_p99,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE operation='PANEL_REQUEST'
        AND created_at>=clock_timestamp()-interval '5 minutes') AS panel_p95,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE operation='TOPUP_CREDIT'
        AND created_at>=clock_timestamp()-interval '24 hours') AS topup_p95,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE operation='TOPUP_CREDIT'
        AND created_at>=clock_timestamp()-interval '24 hours') AS topup_p99,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE operation='OUTBOX_DELIVERY'
        AND created_at>=clock_timestamp()-interval '5 minutes') AS outbox_p95,
      count(*) FILTER (WHERE operation='INTERACTION_ACK' AND created_at>=clock_timestamp()-interval '5 minutes')::integer AS interaction_count
      FROM operation_metrics`),
  ]);
  return { invariant: financial.rows[0], payment: payment.rows[0], queue: queue.rows[0], scheduler: scheduler.rows[0],
    outbox: outbox.rows[0], errors: errors.rows[0], applicationBackupEnabled,
    backupAgeMs: backup.rows[0]?.age_ms == null ? null : Number(backup.rows[0].age_ms),
    restoreAgeMs: restore.rows[0]?.age_ms == null ? null : Number(restore.rows[0].age_ms),
    backupCorruption: Number(backupCorruption.rows[0]?.count ?? 0), restoreFailure: Number(restoreFailure.rows[0]?.count ?? 0),
    counts: counts.rows[0], gates: gates.rows, activeVersions: activeVersions.rows, slo: slo.rows[0] };
}

function versionArrays() {
  return {
    engine: RUNNER_VERSION_COMPATIBILITY.map((item) => item.engine),
    executor: RUNNER_VERSION_COMPATIBILITY.map((item) => item.executor),
    contract: RUNNER_VERSION_COMPATIBILITY.map((item) => item.contract),
    stateSchema: RUNNER_VERSION_COMPATIBILITY.map((item) => item.stateSchema),
  };
}

async function protectVersionCompatibility(pool, snapshot) {
  const versions = versionArrays();
  const incompatibleJobs = Number((await pool.query(`SELECT count(*)::integer AS count FROM runner_jobs j
    WHERE j.state NOT IN ('COMPLETED','FAILED') AND NOT EXISTS(SELECT 1 FROM unnest($1::text[],$2::text[],$3::text[],$4::integer[])
      AS supported(engine,executor,contract,state_schema) WHERE supported.engine=j.engine_version
        AND supported.executor=j.executor_version AND supported.contract=j.contract_version
        AND supported.state_schema=j.runner_state_schema_version)`,
  [versions.engine, versions.executor, versions.contract, versions.stateSchema])).rows[0].count);
  if (incompatibleJobs > 0) await pool.query(`UPDATE feature_gates SET enabled=false,
    reason='RUNNER_VERSION_INCOMPATIBLE',version=version+CASE WHEN enabled THEN 1 ELSE 0 END,
    updated_at=clock_timestamp() WHERE gate='RUNNER_DISPATCH_ENABLED' AND enabled=true`);
  await setIncident(pool, { code: 'RUNNER_VERSION_INCOMPATIBLE', scope: 'RUNNER', active: incompatibleJobs > 0,
    severity: 'CRITICAL', evidence: { count: incompatibleJobs } });
  const incompatibleVersions = snapshot.activeVersions.filter((row) => !isRunnerVersionCompatible(row));
  await setIncident(pool, { code: 'RUNNER_VERSION_INCOMPATIBLE', scope: 'RUNNER', active: incompatibleVersions.length > 0,
    severity: 'ERROR', evidence: { versions: incompatibleVersions } });
}

async function applyFinancialAlerts(pool, invariant) {
  const financialBroken = invariant.negative > 0 || invariant.mismatch > 0 || invariant.duplicate_credit > 0;
  if (financialBroken) await pool.query(`UPDATE feature_gates SET enabled=false,reason='FINANCIAL_INVARIANT',
    version=version+CASE WHEN enabled THEN 1 ELSE 0 END,updated_at=clock_timestamp()
    WHERE gate IN ('AUTO_CREDIT_ENABLED','ORDER_ACCEPTING','TOPUP_ACCEPTING') AND enabled=true`);
  await setIncident(pool, { code: 'FINANCIAL_INVARIANT', scope: 'WALLET_LEDGER', active: financialBroken,
    severity: 'CRITICAL', evidence: invariant });
  await setIncident(pool, { code: 'PAYMENT_AMBIGUOUS', scope: 'TRUEMONEY', active: invariant.ambiguous > 0,
    severity: 'CRITICAL', evidence: { count: invariant.ambiguous } });
  await setIncident(pool, { code: 'FINANCIAL_DLQ', scope: 'OUTBOX', active: invariant.financial_dlq > 0,
    severity: 'CRITICAL', evidence: { count: invariant.financial_dlq } });
  await setIncident(pool, { code: 'DUPLICATE_CREDIT', scope: 'WALLET_LEDGER', active: invariant.duplicate_credit > 0,
    severity: 'CRITICAL', evidence: { count: invariant.duplicate_credit } });
  return financialBroken;
}

async function applyPaymentAlerts(pool, payment, escalatedCount) {
  const redeemedStuck = Number(payment.redeemed_stuck ?? 0) + Number(escalatedCount ?? 0);
  const queueStuck = Number(payment.queue_stuck ?? 0);
  if (queueStuck > 0) await pool.query(`UPDATE feature_gates SET enabled=false,reason='PAYMENT_QUEUE_STUCK',
    version=version+CASE WHEN enabled THEN 1 ELSE 0 END,updated_at=clock_timestamp()
    WHERE gate='TOPUP_ACCEPTING' AND enabled=true`);
  await setIncident(pool, { code: 'TOPUP_REDEEMED_STUCK', scope: 'TRUEMONEY', active: redeemedStuck > 0,
    severity: 'CRITICAL', evidence: { count: redeemedStuck, escalated: Number(escalatedCount ?? 0) } });
  await setIncident(pool, { code: 'PAYMENT_QUEUE_STUCK', scope: 'TRUEMONEY', active: queueStuck > 0,
    severity: 'ERROR', evidence: { count: queueStuck } });
  return { redeemedStuck, queueStuck };
}

async function applyOperationalAlerts(pool, snapshot, health, runtime) {
  await setIncident(pool, { code: 'QUEUE_STUCK', scope: 'RUNNER', active: snapshot.queue.stuck > 0, severity: 'ERROR', evidence: snapshot.queue });
  await setIncident(pool, { code: 'SCHEDULER_LAG', scope: 'RUNNER', active: Number(snapshot.scheduler.lag_ms) > 5_000,
    severity: 'ERROR', evidence: snapshot.scheduler });
  await setIncident(pool, { code: 'OUTBOX_STUCK', scope: 'DISCORD', active: snapshot.outbox.stuck > 0, severity: 'ERROR', evidence: snapshot.outbox });
  const errorRateHigh = snapshot.errors.total >= 20 && snapshot.errors.failed / snapshot.errors.total >= 0.05;
  await setIncident(pool, { code: 'ERROR_RATE_HIGH', scope: 'OPERATIONS', active: errorRateHigh, severity: 'ERROR', evidence: snapshot.errors });
  const backupChecks = snapshot.applicationBackupEnabled;
  await setIncident(pool, { code: 'BACKUP_STALE', scope: 'DATABASE', active: backupChecks && snapshot.backupAgeMs > 26 * HOUR_MS,
    severity: 'ERROR', evidence: { ageMs: snapshot.backupAgeMs } });
  await setIncident(pool, { code: 'RESTORE_DRILL_STALE', scope: 'DATABASE', active: backupChecks && snapshot.restoreAgeMs > 35 * DAY_MS,
    severity: 'ERROR', evidence: { ageMs: snapshot.restoreAgeMs } });
  await setIncident(pool, { code: 'BACKUP_CORRUPTION', scope: 'DATABASE', active: backupChecks && snapshot.backupCorruption > 0,
    severity: 'CRITICAL', evidence: { count: snapshot.backupCorruption } });
  await setIncident(pool, { code: 'RESTORE_DRILL_FAILED', scope: 'DATABASE', active: backupChecks && snapshot.restoreFailure > 0,
    severity: 'CRITICAL', evidence: { count: snapshot.restoreFailure } });
  const staleWorkers = Object.entries(health.workers).filter(([, worker]) => worker.lastHeartbeatAt
    && Date.now() - Date.parse(worker.lastHeartbeatAt) > 120_000).map(([name, worker]) => ({
    name,
    inFlight: Boolean(worker.inFlight),
    inFlightSince: worker.inFlightSince ?? null,
    lastHeartbeatAt: worker.lastHeartbeatAt,
    lastCompletedAt: worker.lastCompletedAt ?? null,
  }));
  await setIncident(pool, { code: 'WORKER_HEARTBEAT_MISSING', scope: 'RUNTIME', active: staleWorkers.length > 0,
    severity: 'ERROR', evidence: { workers: staleWorkers } });
  const sustained = (await pool.query(`SELECT count(*) FILTER (WHERE operation='SYSTEM:MEMORY_PERCENT' AND outcome='ERROR'
    AND created_at>=clock_timestamp()-interval '10 minutes')::integer AS memory_high,
    count(*) FILTER (WHERE operation='SYSTEM:EVENT_LOOP_LAG' AND outcome='ERROR'
      AND created_at>=clock_timestamp()-interval '5 minutes')::integer AS event_loop_high FROM operation_metrics`)).rows[0];
  await setIncident(pool, { code: 'MEMORY_PRESSURE', scope: 'RUNTIME', active: sustained.memory_high >= 10,
    severity: 'ERROR', evidence: { percent: runtime.memoryPercent, rssBytes: runtime.rssBytes,
      memoryLimitBytes: runtime.memoryLimit, highSamples: sustained.memory_high } });
  await setIncident(pool, { code: 'EVENT_LOOP_LAG', scope: 'RUNTIME', active: sustained.event_loop_high >= 5,
    severity: 'ERROR', evidence: { p99Ms: runtime.eventLoopLagMs, highSamples: sustained.event_loop_high } });
  const interactionP95 = Number(snapshot.slo.interaction_ack_p95 ?? 0);
  const interactionP99 = Number(snapshot.slo.interaction_ack_p99 ?? 0);
  const panelP95 = Number(snapshot.slo.panel_p95 ?? 0);
  const topupP95 = Number(snapshot.slo.topup_p95 ?? 0);
  const topupP99 = Number(snapshot.slo.topup_p99 ?? 0);
  const outboxP95 = Number(snapshot.slo.outbox_p95 ?? 0);
  await setIncident(pool, { code: 'INTERACTION_ACK_SLO', scope: 'DISCORD',
    active: Number(snapshot.slo.interaction_count) >= 20 && (interactionP95 > 2_000 || interactionP99 >= 2_800),
    severity: 'ERROR', evidence: { p95Ms: interactionP95, p99Ms: interactionP99, count: snapshot.slo.interaction_count } });
  await setIncident(pool, { code: 'PANEL_LATENCY_SLO', scope: 'DISCORD', active: panelP95 > 5_000,
    severity: 'WARNING', evidence: { p95Ms: panelP95 } });
  await setIncident(pool, { code: 'TOPUP_LATENCY_SLO', scope: 'TRUEMONEY', active: topupP95 > 60_000,
    severity: 'WARNING', evidence: { p95Ms: topupP95, p99Ms: topupP99 } });
  await setIncident(pool, { code: 'TOPUP_LATENCY_P99_SLO', scope: 'TRUEMONEY', active: topupP99 > 300_000,
    severity: 'WARNING', evidence: { p99Ms: topupP99 } });
  await setIncident(pool, { code: 'OUTBOX_LATENCY_SLO', scope: 'DISCORD', active: outboxP95 > 30_000,
    severity: 'WARNING', evidence: { p95Ms: outboxP95 } });
}

function resolveHealthStatus({ financialBroken, paymentState, health, snapshot }) {
  if (financialBroken || paymentState.redeemedStuck > 0 || snapshot.backupCorruption > 0 || snapshot.restoreFailure > 0) return 'INCIDENT';
  if (!health.ready) return 'NOT_READY';
  if (paymentState.queueStuck > 0 || snapshot.queue.stuck || snapshot.outbox.stuck || Number(snapshot.scheduler.lag_ms) > 5_000) return 'DEGRADED';
  if (!snapshot.counts.store_open) return 'MAINTENANCE';
  return 'HEALTHY';
}

export async function evaluateAlerts({ pool, health, env = { BACKUP_ENABLED: true }, eventLoopMonitor = null }) {
  const runtime = await collectRuntimeMetrics(pool, eventLoopMonitor);
  const escalated = await escalateStuckRedeemedTopups({ olderThanSeconds: 120, limit: 20 },
    alertContext('redeemed-settlement'), { pool });
  const snapshot = await collectAlertSnapshot(pool, { applicationBackupEnabled: usesApplicationBackup(env) });
  await protectVersionCompatibility(pool, snapshot);
  const financialBroken = await applyFinancialAlerts(pool, snapshot.invariant);
  const paymentState = await applyPaymentAlerts(pool, snapshot.payment, escalated.length);
  await applyOperationalAlerts(pool, snapshot, health, runtime);
  health.overview = { ...snapshot.counts, queueSoftLimit: 400, queueHardLimit: 500,
    payment: { ...snapshot.payment, escalatedRedeemed: escalated.length },
    gates: Object.fromEntries(snapshot.gates.map((row) => [row.gate, { enabled: row.enabled, version: Number(row.version) }])),
    backupMode: snapshot.applicationBackupEnabled ? 'LOCAL_S3' : 'AIVEN_MANAGED',
    backupAgeMs: snapshot.backupAgeMs,
    restoreAgeMs: snapshot.restoreAgeMs,
    memoryRssBytes: runtime.rssBytes, memoryLimitBytes: runtime.memoryLimit, memoryPercent: runtime.memoryPercent,
    eventLoopLagP99Ms: runtime.eventLoopLagMs,
    slo: {
      interactionAckP95Ms: Number(snapshot.slo.interaction_ack_p95 ?? 0),
      interactionAckP99Ms: Number(snapshot.slo.interaction_ack_p99 ?? 0),
      panelP95Ms: Number(snapshot.slo.panel_p95 ?? 0),
      topupP95Ms: Number(snapshot.slo.topup_p95 ?? 0),
      topupP99Ms: Number(snapshot.slo.topup_p99 ?? 0),
      outboxP95Ms: Number(snapshot.slo.outbox_p95 ?? 0),
    } };
  health.status = resolveHealthStatus({ financialBroken, paymentState, health, snapshot });
  return false;
}
