import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { processPayment } from '../../src/workers/payment-worker.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

function workerEnv() {
  return {
    DISCORD_GUILD_ID: '10000000000000002',
    DATA_ENCRYPTION_KEYS_JSON: { current: 1, keys: { 1: Buffer.alloc(32, 1).toString('base64') } },
  };
}

test('disabled automatic settlement never claims or redeems a queued voucher', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const receiver = uuidv7();
  const topup = uuidv7();
  const trace = uuidv7();
  await pool.query(`INSERT INTO receiver_versions(id,version,encrypted_phone,encryption_key_version,
    nonce,auth_tag,phone_last4,state,actor_id,trace_id) VALUES($1,1,$2,1,$3,$4,'1234','ACTIVE','owner',$5)`,
  [receiver, Buffer.alloc(10), Buffer.alloc(12), Buffer.alloc(16), trace]);
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,trace_id)
    VALUES($1,'containment-user','PAYMENT_QUEUED',1,$2,$3,'1234',$4)`,
  [topup, Buffer.alloc(32, 81), receiver, trace]);
  await pool.query(`UPDATE feature_gates SET enabled=true,reason='test' WHERE gate='TOPUP_ACCEPTING'`);

  const processed = await processPayment({ holder: uuidv7(), env: workerEnv(),
    signal: new AbortController().signal, autoCredit: false, pool });
  assert.equal(processed, false);
  assert.equal((await pool.query('SELECT status FROM topups WHERE id=$1', [topup])).rows[0].status, 'PAYMENT_QUEUED');
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM payment_attempts WHERE topup_id=$1', [topup])).rows[0].count), 0);
  const gate = (await pool.query("SELECT enabled,reason FROM feature_gates WHERE gate='TOPUP_ACCEPTING'")).rows[0];
  assert.equal(gate.enabled, false);
  assert.equal(gate.reason, 'AUTO_CREDIT_DISABLED');
});

test('automatic settlement recovers a durable REDEEMED top-up without calling the provider again', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const receiver = (await pool.query("SELECT id FROM receiver_versions WHERE state='ACTIVE' LIMIT 1")).rows[0].id;
  const topup = uuidv7();
  const trace = uuidv7();
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,provider_transaction_id,amount_cents,currency,trace_id,redeemed_at)
    VALUES($1,'recovery-user','REDEEMED',1,$2,$3,'1234',$4,2500,'THB',$5,clock_timestamp())`,
  [topup, Buffer.alloc(32, 82), receiver, `provider-${topup}`, trace]);

  const processed = await processPayment({ holder: uuidv7(), env: workerEnv(),
    signal: new AbortController().signal, autoCredit: true, pool });
  assert.equal(processed, true);
  assert.equal((await pool.query('SELECT status FROM topups WHERE id=$1', [topup])).rows[0].status, 'CREDITED');
  assert.equal(BigInt((await pool.query("SELECT available_cents FROM wallets WHERE discord_user_id='recovery-user'")).rows[0].available_cents), 2500n);
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM payment_attempts WHERE topup_id=$1', [topup])).rows[0].count), 0);
});

test('an over-limit redeemed voucher credits the full amount and locks further top-ups for the day', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const receiver = (await pool.query("SELECT id FROM receiver_versions WHERE state='ACTIVE' LIMIT 1")).rows[0].id;
  const topup = uuidv7();
  const trace = uuidv7();
  const user = `over-limit-${trace}`;
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,provider_transaction_id,amount_cents,currency,trace_id,redeemed_at)
    VALUES($1,$2,'REDEEMED',1,$3,$4,'1234',$5,100001,'THB',$6,clock_timestamp())`,
  [topup, user, Buffer.alloc(32, 83), receiver, `provider-${topup}`, trace]);

  const processed = await processPayment({ holder: uuidv7(), env: workerEnv(),
    signal: new AbortController().signal, autoCredit: true, pool });
  assert.equal(processed, true);
  assert.equal((await pool.query('SELECT status FROM topups WHERE id=$1', [topup])).rows[0].status, 'CREDITED');
  assert.equal(BigInt((await pool.query('SELECT available_cents FROM wallets WHERE discord_user_id=$1', [user])).rows[0].available_cents), 100_001n);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM topup_daily_locks WHERE discord_user_id=$1', [user])).rows[0].count, 1);
  assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM incidents
    WHERE incident_code='TOPUP_AMOUNT_OVER_AUTOCREDIT_LIMIT' AND state<>'RESOLVED'`)).rows[0].count > 0, true);
});
