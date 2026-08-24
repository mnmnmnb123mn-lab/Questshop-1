import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { submitVoucher } from '../../src/domain/payments/service.js';

let pool;
let receiver;
const key = Buffer.alloc(32, 7).toString('base64');
const env = { PRELAUNCH: true, DATA_ENCRYPTION_KEYS_JSON: { current: 1, keys: { 1: key } },
  VOUCHER_HMAC_KEYS_JSON: { current: 1, keys: { 1: key } } };

before(async () => {
  pool = await createTestPool();
  if (!pool) return;
  receiver = uuidv7();
  const trace = uuidv7();
  await pool.query(`INSERT INTO receiver_versions(id,version,encrypted_phone,encryption_key_version,
    nonce,auth_tag,phone_last4,state,actor_id,trace_id) VALUES($1,1,$2,1,$3,$4,'1234','ACTIVE','owner',$5)`,
  [receiver, Buffer.alloc(10), Buffer.alloc(12), Buffer.alloc(16), trace]);
  await pool.query(`UPDATE feature_gates SET enabled=true,reason='test'
    WHERE gate IN ('TOPUP_ACCEPTING','AUTO_CREDIT_ENABLED')`);
});
after(async () => { await pool?.end(); });

function makeContext(actorId, idempotencyKey) {
  return createContext({ actorType: 'CUSTOMER', actorId,
    guildId: '10000000000000002', idempotencyKey });
}

test('same voucher submitted concurrently has one durable owner', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const input = { discordUserId: 'voucher-user', voucherUrl: 'https://gift.truemoney.com/campaign/?v=ABCDEFGHIJKLMNOP', env };
  const results = await Promise.all([
    submitVoucher(input, makeContext('voucher-user', 'voucher-a'), { pool }),
    submitVoucher(input, makeContext('voucher-user', 'voucher-b'), { pool }),
  ]);
  assert.equal(new Set(results.map((result) => result.topup.id)).size, 1);
  assert.equal(Number((await pool.query("SELECT count(*) AS count FROM topups WHERE discord_user_id='voucher-user'")).rows[0].count), 1);
});

test('same voucher cannot reveal another customer durable top-up', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  await assert.rejects(() => submitVoucher({ discordUserId: 'voucher-other',
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=ABCDEFGHIJKLMNOP', env },
  makeContext('voucher-other', 'voucher-other'), { pool }),
  (error) => error.code === 'NOT_AUTHORIZED' && /ส่งเข้าระบบแล้ว/.test(error.message));
});

test('customer cannot queue a second voucher while one top-up is still active', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const user = 'pending-voucher-user';
  await submitVoucher({ discordUserId: user,
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=QRSTUVWXYZABCDEF', env },
  makeContext(user, 'pending-1'), { pool });
  await assert.rejects(() => submitVoucher({ discordUserId: user,
    voucherUrl: 'https://gift.truemoney.com/campaign/?v=FEDCBAZYXWVUTSRQ', env },
  makeContext(user, 'pending-2'), { pool }),
  (error) => error.code === 'RATE_LIMITED' && /รายการเติมเงินกำลังตรวจสอบ/.test(error.message));
});
