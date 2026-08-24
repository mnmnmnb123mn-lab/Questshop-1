import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import {
  addMonitor, checkAllMonitorHealth, checkMonitorHealth, rotateMonitorCredential, setMonitorState,
} from '../../src/domain/admin/monitor-service.js';
import { setCircuitBreakerState } from '../../src/domain/admin/operations-service.js';
import {
  replaceManualPromotion, setManualPromotionEnabled, setQuestCategoryPrice, updateRuntimeConfig,
} from '../../src/domain/admin/config-service.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

const keyring = { current: 1, keys: { 1: Buffer.alloc(32, 7).toString('base64') } };
const env = { DATA_ENCRYPTION_KEYS_JSON: keyring };
const context = createContext({ actorType: 'OWNER', actorId: 'owner', guildId: 'guild',
  idempotencyKey: 'admin-operations' });

test('first runtime config update accepts the visible baseline and retires legacy Admin Role ID', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const changed = await updateRuntimeConfig({
    patch: { adminRoleId: '123456789012345678', questAnnouncementRoleId: '223456789012345678' },
    expectedVersion: 1,
    reason: 'configure Quest announcement role',
  }, context, { pool });
  assert.equal(Number(changed.version), 1);
  assert.equal(changed.payload.questAnnouncementRoleId, '223456789012345678');
  assert.equal(Object.hasOwn(changed.payload, 'adminRoleId'), false);
});

test('monitor credential rotation validates the same account and never exposes plaintext', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const factory = ({ token }) => ({ fetchCurrentUser: async () => ({
    id: token === 'other-token' ? 'account-2' : 'account-1', username: 'monitor',
  }) });
  const monitor = await addMonitor({ token: 'initial-token', env }, context, { pool, questApiFactory: factory });
  assert.equal(monitor.account_id, 'account-1');
  assert.deepEqual(monitor.capabilities, ['SCAN', 'TEST']);
  await setMonitorState({ monitorId: monitor.id, state: 'QUARANTINED',
    expectedState: monitor.state, expectedVersion: monitor.state_version },
    context, { pool });
  await assert.rejects(() => rotateMonitorCredential({ monitorId: monitor.id, token: 'other-token', env },
    context, { pool, questApiFactory: factory }), /does not match/);
  const rotated = await rotateMonitorCredential({ monitorId: monitor.id, token: 'replacement-token', env },
    context, { pool, questApiFactory: factory });
  assert.equal(rotated.state, 'ACTIVE');
  const credential = (await pool.query('SELECT * FROM monitor_credentials WHERE monitor_id=$1', [monitor.id])).rows[0];
  assert.notEqual(credential.ciphertext.toString('utf8'), 'replacement-token');
  const audit = (await pool.query(`SELECT action,before_state,after_state FROM admin_audit_logs
    WHERE target_id=$1 ORDER BY created_at`, [monitor.id])).rows;
  assert.deepEqual(audit.map((row) => row.action), [
    'ADD_MONITOR', 'MONITOR_STATE_CHANGE', 'ROTATE_MONITOR_CREDENTIAL',
  ]);
});

test('monitor health check is read-only, records readiness, and quarantines an invalid token', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const calls = [];
  const invalidMonitorTokens = new Set(['invalid-token']);
  const factory = ({ token }) => ({
    fetchCurrentUser: async () => {
      calls.push(`profile:${token}`);
      if (invalidMonitorTokens.has(token)) {
        const error = new Error('unauthorized');
        error.status = 401;
        throw error;
      }
      return { id: token === 'healthy-token' ? 'monitor-health' : 'monitor-invalid', username: token };
    },
    fetchQuests: async () => {
      calls.push(`quests:${token}`);
      return [{ id: 'quest-a' }, { id: 'quest-b' }];
    },
  });
  const healthy = await addMonitor({ token: 'healthy-token', env }, context, { pool, questApiFactory: factory });
  const invalid = await addMonitor({ token: 'valid-before-rotation', env }, context, { pool, questApiFactory: factory });
  await rotateMonitorCredential({ monitorId: invalid.id, token: 'invalid-token', env }, context, {
    pool,
    questApiFactory: ({ token }) => ({ fetchCurrentUser: async () => ({ id: 'monitor-invalid', username: token }) }),
  });

  calls.length = 0;
  const ready = await checkMonitorHealth({ monitorId: healthy.id, env }, context, { pool, questApiFactory: factory });
  assert.equal(ready.healthState, 'READY');
  assert.equal(ready.questCount, 2);
  assert.equal(Object.hasOwn(ready.monitor, 'key_version'), false);
  assert.equal(Object.hasOwn(ready.monitor, 'nonce'), false);
  assert.equal(Object.hasOwn(ready.monitor, 'ciphertext'), false);
  assert.equal(Object.hasOwn(ready.monitor, 'auth_tag'), false);
  assert.deepEqual(calls, ['profile:healthy-token', 'quests:healthy-token']);

  const failed = await checkMonitorHealth({ monitorId: invalid.id, env }, context, { pool, questApiFactory: factory });
  assert.equal(failed.healthState, 'INVALID');
  assert.equal(failed.errorCode, 'TOKEN_REJECTED');
  const row = (await pool.query(`SELECT state,health_state,last_health_quest_count,last_health_error_code
    FROM monitor_accounts WHERE id=$1`, [invalid.id])).rows[0];
  assert.deepEqual(row, {
    state: 'QUARANTINED', health_state: 'INVALID', last_health_quest_count: null,
    last_health_error_code: 'TOKEN_REJECTED',
  });

  const disabled = await setMonitorState({ monitorId: healthy.id, state: 'DISABLED',
    expectedState: ready.monitor.state, expectedVersion: ready.monitor.state_version }, context, { pool });
  invalidMonitorTokens.add('healthy-token');
  const disabledInvalid = await checkMonitorHealth({ monitorId: healthy.id, env }, context,
    { pool, questApiFactory: factory });
  assert.equal(disabledInvalid.healthState, 'INVALID');
  assert.equal(disabledInvalid.monitor.state, 'DISABLED');
  await assert.rejects(() => setMonitorState({ monitorId: healthy.id, state: 'ACTIVE',
    expectedState: 'DISABLED', expectedVersion: Number(disabled.state_version) - 1 }, context, { pool }),
  (error) => error.code === 'STALE_STATE');
  const all = await checkAllMonitorHealth({ env }, context, { pool, questApiFactory: factory });
  const disabledResult = all.find((result) => result.monitor.id === healthy.id);
  assert.equal(disabledResult?.healthState, 'INVALID');
  assert.equal(disabledResult?.monitor.state, 'DISABLED');
  assert.ok(all.some((result) => result.monitor.id === invalid.id));
  const plaintext = JSON.stringify((await pool.query(`SELECT before_state,after_state FROM admin_audit_logs
    WHERE action='MONITOR_HEALTH_CHECK'`)).rows);
  assert.equal(plaintext.includes('healthy-token'), false);
  assert.equal(plaintext.includes('invalid-token'), false);
});

test('circuit breaker recovery uses optimistic state version and audit', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const initial = (await pool.query("SELECT * FROM circuit_breakers WHERE breaker_key='TRUEMONEY_DIRECT'")).rows[0];
  const halfOpen = await setCircuitBreakerState({ breakerKey: 'TRUEMONEY_DIRECT', nextState: 'HALF_OPEN',
    expectedVersion: initial.state_version, reason: 'owner probe' }, context, { pool });
  assert.equal(halfOpen.state, 'HALF_OPEN');
  await assert.rejects(() => setCircuitBreakerState({ breakerKey: 'TRUEMONEY_DIRECT', nextState: 'CLOSED',
    expectedVersion: initial.state_version, reason: 'stale close' }, context, { pool }),
  (error) => error.code === 'STALE_STATE');
  const closed = await setCircuitBreakerState({ breakerKey: 'TRUEMONEY_DIRECT', nextState: 'CLOSED',
    expectedVersion: halfOpen.state_version, reason: 'probe verified' }, context, { pool });
  assert.equal(closed.state, 'CLOSED');
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM admin_audit_logs
    WHERE target_id='TRUEMONEY_DIRECT' AND action='CIRCUIT_BREAKER_CHANGE'`)).rows[0].count), 2);
});

test('admin changes only the GAME or VIDEO category, with immutable rule snapshots', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const before = (await pool.query(`SELECT task_type,state_version FROM price_rules WHERE enabled=true
    AND rule_type='TYPE' AND task_type IN ('WATCH_VIDEO','WATCH_VIDEO_ON_MOBILE')`)).rows;
  const changed = await setQuestCategoryPrice({ category: 'VIDEO', amountCents: 625n,
    expectedVersions: Object.fromEntries(before.map((row) => [row.task_type, String(row.state_version)])) }, context, { pool });
  assert.equal(changed.rules.length, 2);
  assert.equal(BigInt(changed.amountCents), 625n);
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM price_rules WHERE enabled=true
    AND rule_type='TYPE' AND task_type IN ('WATCH_VIDEO','WATCH_VIDEO_ON_MOBILE')`)).rows[0].count), 2);
  const audit = (await pool.query(`SELECT action FROM admin_audit_logs WHERE target_type='QUEST_PRICE_CATEGORY'`)).rows;
  assert.deepEqual(audit.map((entry) => entry.action), ['QUEST_CATEGORY_PRICE_CHANGED']);
});

test('promotion has no public name or calendar: edits make a new manual version', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const first = await replaceManualPromotion({ tiers: [{ minimumAmountCents: 10_000n, basisPoints: 1_000 }],
    maxUsesPerUser: 2, maxBonusPerDayCents: 5_000n }, context, { pool });
  assert.equal(first.promotion.state, 'ACTIVE');
  assert.equal(first.promotion.manual_controlled, true);
  assert.equal(first.promotion.starts_at, null);
  assert.equal(first.promotion.ends_at, null);
  const disabled = await setManualPromotionEnabled({ enabled: false,
    expectedVersion: first.promotion.state_version }, context, { pool });
  const second = await replaceManualPromotion({ tiers: [{ minimumAmountCents: 30_000n, basisPoints: 1_500 }],
    maxUsesPerUser: null, maxBonusPerDayCents: null }, context, { pool });
  assert.equal(disabled.state, 'DISABLED');
  assert.ok(Number(second.promotion.version) > Number(first.promotion.version));
  const active = (await pool.query("SELECT count(*)::integer AS count FROM promotions WHERE state='ACTIVE'" )).rows[0];
  assert.equal(active.count, 1);
});
