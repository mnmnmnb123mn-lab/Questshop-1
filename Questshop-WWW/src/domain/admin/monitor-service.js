import { v7 as uuidv7 } from 'uuid';
import { decryptSecret, encryptSecret } from '../../adapters/crypto/keyring.js';
import { createQuestApiClient, profileFromEnv } from '../../quest-engine/api/client.js';
import { getPersistentDiscordRateLimitCoordinator } from '../../quest-engine/rate-limits/coordinator.js';
import { withTransaction } from '../../db/transaction.js';
import { appendAdminAudit } from './audit.js';
import { StaleStateError } from '../../shared/errors.js';

const MONITOR_CAPABILITIES = Object.freeze(['SCAN', 'TEST']);
const MONITOR_CREDENTIAL_FIELDS = new Set(['key_version', 'nonce', 'ciphertext', 'auth_tag']);
const DEFAULT_MONITOR_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_ALL_MONITORS_DEADLINE_MS = 90_000;

function publicMonitor(monitor) {
  if (!monitor) return monitor;
  return Object.fromEntries(Object.entries(monitor)
    .filter(([field]) => !MONITOR_CREDENTIAL_FIELDS.has(field)));
}

function monitorName(profile) {
  return profile.global_name ?? profile.username ?? String(profile.id);
}

function healthErrorCode(error) {
  if (error?.fatalAuth || [401, 403].includes(error?.status)) return 'TOKEN_REJECTED';
  if (error?.code === 'SECRET_DECRYPT_FAILED') return 'SECRET_DECRYPT_FAILED';
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'HEALTH_CHECK_TIMEOUT';
  if (error?.status === 429) return 'RATE_LIMITED';
  if (Number(error?.status) >= 500 || error?.name === 'DiscordApiTransportError') return 'DISCORD_UNAVAILABLE';
  return error?.code ?? error?.name ?? 'HEALTH_CHECK_FAILED';
}

export async function addMonitor({ token, env }, context, options = {}) {
  if (!token?.trim()) throw new TypeError('monitor token is required');
  const questApiFactory = options.questApiFactory ?? createQuestApiClient;
  const profile = await questApiFactory({ token, profile: profileFromEnv(env),
    coordinator: options.coordinator ?? getPersistentDiscordRateLimitCoordinator(options.pool) }).fetchCurrentUser();
  if (!profile?.id) throw new TypeError('monitor token profile is invalid');
  const id = uuidv7();
  const encrypted = encryptSecret(token, env.DATA_ENCRYPTION_KEYS_JSON, `monitor:${id}:${context.guildId}`);
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const row = (await client.query(`INSERT INTO monitor_accounts(id,account_id,username,capabilities,state)
      VALUES($1,$2,$3,$4,'ACTIVE') RETURNING *`, [id, String(profile.id), monitorName(profile),
      MONITOR_CAPABILITIES])).rows[0];
    await client.query(`INSERT INTO monitor_credentials(monitor_id,key_version,nonce,ciphertext,auth_tag)
      VALUES($1,$2,$3,$4,$5)`, [id, encrypted.keyVersion, encrypted.nonce, encrypted.ciphertext, encrypted.authTag]);
    await appendAdminAudit(client, { action: 'ADD_MONITOR', targetType: 'MONITOR', targetId: id,
      actorId: context.actorId, after: { accountId: row.account_id, capabilities: row.capabilities },
      reason: 'Owner added Monitor token', context });
    return row;
  });
}

export async function rotateMonitorCredential({ monitorId, token, env }, context, options = {}) {
  if (!token?.trim()) throw new TypeError('token is required');
  const questApiFactory = options.questApiFactory ?? createQuestApiClient;
  const profile = await questApiFactory({ token, profile: profileFromEnv(env),
    coordinator: options.coordinator ?? getPersistentDiscordRateLimitCoordinator(options.pool) }).fetchCurrentUser();
  const encrypted = encryptSecret(token, env.DATA_ENCRYPTION_KEYS_JSON,
    `monitor:${monitorId}:${context.guildId}`);
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const monitor = (await client.query('SELECT * FROM monitor_accounts WHERE id=$1 FOR UPDATE', [monitorId])).rows[0];
    if (String(profile.id) !== monitor?.account_id) throw new TypeError('Monitor token account does not match');
    const credential = (await client.query('SELECT key_version FROM monitor_credentials WHERE monitor_id=$1 FOR UPDATE',
      [monitorId])).rows[0];
    await client.query(`UPDATE monitor_credentials SET key_version=$2,nonce=$3,ciphertext=$4,auth_tag=$5,
      updated_at=transaction_timestamp() WHERE monitor_id=$1`, [monitorId, encrypted.keyVersion,
      encrypted.nonce, encrypted.ciphertext, encrypted.authTag]);
    const updated = (await client.query(`UPDATE monitor_accounts SET state='ACTIVE',consecutive_failures=0,
      state_version=state_version+CASE WHEN state<>'ACTIVE' THEN 1 ELSE 0 END,
      cooldown_until=NULL,updated_at=transaction_timestamp() WHERE id=$1 RETURNING *`, [monitorId])).rows[0];
    await appendAdminAudit(client, { action: 'ROTATE_MONITOR_CREDENTIAL', targetType: 'MONITOR',
      targetId: monitorId, actorId: context.actorId,
      before: { state: monitor.state, keyVersion: credential.key_version },
      after: { state: updated.state, keyVersion: encrypted.keyVersion },
      reason: 'Owner rotated Monitor token', context });
    return updated;
  });
}

export async function setMonitorState({ monitorId, state, expectedState, expectedVersion }, context, options = {}) {
  if (!['ACTIVE', 'QUARANTINED', 'DISABLED'].includes(state)) {
    throw new TypeError('invalid monitor state change');
  }
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const before = (await client.query('SELECT * FROM monitor_accounts WHERE id=$1 FOR UPDATE', [monitorId])).rows[0];
    if (!before) throw new TypeError('monitor not found');
    if (before.state !== expectedState || Number(before.state_version) !== Number(expectedVersion)) {
      throw new StaleStateError('Monitor', monitorId);
    }
    const updated = (await client.query(`UPDATE monitor_accounts SET state=$2,state_version=state_version+1,
      cooldown_until=CASE WHEN $2='ACTIVE' THEN NULL ELSE cooldown_until END,
      updated_at=transaction_timestamp()
      WHERE id=$1 AND state=$3 AND state_version=$4 RETURNING *`,
    [monitorId, state, expectedState, expectedVersion])).rows[0];
    if (!updated) throw new StaleStateError('Monitor', monitorId);
    await appendAdminAudit(client, { action: 'MONITOR_STATE_CHANGE', targetType: 'MONITOR',
      targetId: monitorId, actorId: context.actorId, before: { state: before.state },
      after: { state: updated.state }, reason: `Owner set Monitor ${state}`, context });
    return updated;
  });
}

async function loadMonitorCredential(monitorId, options) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED', maxAttempts: 1 }, async (client) => (
    (await client.query(`SELECT m.*,c.key_version,c.nonce,c.ciphertext,c.auth_tag
      FROM monitor_accounts m JOIN monitor_credentials c ON c.monitor_id=m.id
      WHERE m.id=$1`, [monitorId])).rows[0]
  ));
}

async function persistHealth({ monitor, outcome, context }, options) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const row = (await client.query(`UPDATE monitor_accounts m SET
      health_state=$2,last_health_checked_at=clock_timestamp(),last_health_error_code=$3,
      last_health_quest_count=$4,last_health_account_id=$5,
      state=CASE WHEN $2='INVALID' AND m.state<>'DISABLED' THEN 'QUARANTINED' ELSE m.state END,
      state_version=state_version+CASE
        WHEN $2='INVALID' AND m.state NOT IN ('DISABLED','QUARANTINED') THEN 1 ELSE 0 END,
      consecutive_failures=CASE WHEN $2='INVALID' THEN m.consecutive_failures+1
        WHEN $2='READY' THEN 0 ELSE m.consecutive_failures END,
      updated_at=clock_timestamp()
      WHERE m.id=$1 AND m.state_version=$10
        AND EXISTS(SELECT 1 FROM monitor_credentials c WHERE c.monitor_id=m.id
        AND c.key_version=$6 AND c.nonce=$7 AND c.ciphertext=$8 AND c.auth_tag=$9)
      RETURNING m.*`, [monitor.id, outcome.healthState, outcome.errorCode ?? null,
      outcome.questCount ?? null, outcome.accountId ?? null, monitor.key_version,
      monitor.nonce, monitor.ciphertext, monitor.auth_tag, monitor.state_version])).rows[0];
    if (!row) return null;
    await appendAdminAudit(client, { action: 'MONITOR_HEALTH_CHECK', targetType: 'MONITOR',
      targetId: row.id, actorId: context.actorId,
      before: { state: monitor.state, healthState: monitor.health_state },
      after: { state: row.state, healthState: row.health_state, questCount: row.last_health_quest_count,
        errorCode: row.last_health_error_code }, reason: 'Owner requested Monitor health check', context });
    return row;
  });
}

// A health check is read-only: it confirms credential decryption, identity
// binding and Quest-list access. It never enrolls or progresses a Quest.
export async function checkMonitorHealth({ monitorId, env }, context, options = {}) {
  const monitor = await loadMonitorCredential(monitorId, options);
  if (!monitor) throw new TypeError('monitor not found');
  const questApiFactory = options.questApiFactory ?? createQuestApiClient;
  let outcome;
  try {
    const timeoutMs = Math.max(1, Number(options.timeoutMs ?? DEFAULT_MONITOR_HEALTH_TIMEOUT_MS));
    const signal = AbortSignal.timeout(timeoutMs);
    const token = decryptSecret({ keyVersion: monitor.key_version, nonce: monitor.nonce,
      ciphertext: monitor.ciphertext, authTag: monitor.auth_tag }, env.DATA_ENCRYPTION_KEYS_JSON,
    `monitor:${monitor.id}:${context.guildId}`);
    const api = questApiFactory({ token, profile: profileFromEnv(env),
      coordinator: options.coordinator ?? getPersistentDiscordRateLimitCoordinator(options.pool) });
    const [profile, quests] = await Promise.all([api.fetchCurrentUser(signal), api.fetchQuests(signal)]);
    if (!profile?.id || String(profile.id) !== monitor.account_id) {
      const mismatch = Object.assign(new Error('Monitor account mismatch'), { fatalAuth: true });
      throw mismatch;
    }
    outcome = { healthState: 'READY', accountId: String(profile.id), questCount: quests.length };
  } catch (error) {
    const code = healthErrorCode(error);
    outcome = { healthState: code === 'TOKEN_REJECTED' || code === 'SECRET_DECRYPT_FAILED' ? 'INVALID' : 'DEGRADED',
      errorCode: code };
  }
  const persisted = await persistHealth({ monitor, outcome, context }, options);
  return { monitor: publicMonitor(persisted ?? monitor), ...outcome, staleCredential: !persisted };
}

export async function checkAllMonitorHealth({ env }, context, options = {}) {
  const monitors = await withTransaction({ ...options, isolation: 'READ COMMITTED', maxAttempts: 1 }, async (client) => (
    (await client.query(`SELECT id FROM monitor_accounts
      ORDER BY priority DESC,last_used_at NULLS FIRST,created_at`)).rows
  ));
  // This is a local latency budget, not a durable business deadline. A
  // monotonic clock remains correct if the host wall clock changes mid-check.
  const startedAt = performance.now();
  const deadlineMs = Math.max(1, Number(options.deadlineMs ?? DEFAULT_ALL_MONITORS_DEADLINE_MS));
  const results = [];
  for (const monitor of monitors) {
    const remainingMs = deadlineMs - (performance.now() - startedAt);
    if (remainingMs <= 0) {
      results.push({ monitor: { id: monitor.id }, healthState: 'DEGRADED',
        errorCode: 'HEALTH_CHECK_DEADLINE', staleCredential: false });
      continue;
    }
    results.push(await checkMonitorHealth({ monitorId: monitor.id, env }, context, {
      ...options,
      timeoutMs: Math.min(Number(options.timeoutMs ?? DEFAULT_MONITOR_HEALTH_TIMEOUT_MS), remainingMs),
    }));
  }
  return results;
}
