import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { adjustBalance } from '../../src/domain/wallet/service.js';
import { evaluateAlerts } from '../../src/workers/alert-worker.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

function health() { return { ready: true, status: 'HEALTHY', workers: {} }; }
const env = { BACKUP_MODE: 'AIVEN_MANAGED' };

async function gates(names) {
  const rows = (await pool.query('SELECT gate,enabled,reason FROM feature_gates WHERE gate=ANY($1::text[])', [names])).rows;
  return Object.fromEntries(rows.map((row) => [row.gate, row]));
}

test('financial invariant immediately closes top-up intake together with auto credit and orders', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'OWNER', actorId: 'owner', guildId: '10000000000000002',
    idempotencyKey: 'payment-alert-financial' });
  await adjustBalance({ discordUserId: 'payment-alert-user', amountCents: 500n, reason: 'seed' }, context, { pool });
  await pool.query('UPDATE wallets SET available_cents=499 WHERE discord_user_id=$1', ['payment-alert-user']);
  await pool.query(`UPDATE feature_gates SET enabled=true,reason='test',version=version+1
    WHERE gate IN ('AUTO_CREDIT_ENABLED','ORDER_ACCEPTING','TOPUP_ACCEPTING')`);

  const state = health();
  await evaluateAlerts({ pool, health: state, env });
  const current = await gates(['AUTO_CREDIT_ENABLED', 'ORDER_ACCEPTING', 'TOPUP_ACCEPTING']);
  assert.equal(current.AUTO_CREDIT_ENABLED.enabled, false);
  assert.equal(current.ORDER_ACCEPTING.enabled, false);
  assert.equal(current.TOPUP_ACCEPTING.enabled, false);
  assert.equal(current.TOPUP_ACCEPTING.reason, 'FINANCIAL_INVARIANT');
  assert.equal(state.status, 'INCIDENT');

  await pool.query('UPDATE wallets SET available_cents=500 WHERE discord_user_id=$1', ['payment-alert-user']);
});

test('stale payment queue opens an incident and stops new top-up intake', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const trace = uuidv7();
  const receiver = uuidv7();
  const version = Number((await pool.query('SELECT COALESCE(max(version),0)+1 AS version FROM receiver_versions')).rows[0].version);
  await pool.query(`INSERT INTO receiver_versions(id,version,encrypted_phone,encryption_key_version,
    nonce,auth_tag,phone_last4,state,actor_id,trace_id) VALUES($1,$2,$3,1,$4,$5,'1234','ACTIVE','owner',$6)`,
  [receiver, version, Buffer.alloc(10), Buffer.alloc(12), Buffer.alloc(16), trace]);
  const topup = uuidv7();
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,trace_id,updated_at)
    VALUES($1,'payment-queue-stuck-user','PAYMENT_QUEUED',1,$2,$3,'1234',$4,clock_timestamp()-interval '10 minutes')`,
  [topup, Buffer.alloc(32, 101), receiver, trace]);
  await pool.query("UPDATE feature_gates SET enabled=true,reason='test',version=version+1 WHERE gate='TOPUP_ACCEPTING'");

  const state = health();
  await evaluateAlerts({ pool, health: state, env });
  const intake = (await gates(['TOPUP_ACCEPTING'])).TOPUP_ACCEPTING;
  assert.equal(intake.enabled, false);
  assert.equal(intake.reason, 'PAYMENT_QUEUE_STUCK');
  const incident = (await pool.query(`SELECT state FROM incidents
    WHERE incident_code='PAYMENT_QUEUE_STUCK' AND scope='TRUEMONEY' ORDER BY opened_at DESC LIMIT 1`)).rows[0];
  assert.equal(incident.state, 'OPEN');
  assert.equal(state.status, 'DEGRADED');
});
