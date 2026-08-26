import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPool } from '../fixtures/postgres.js';
import { loadCustomerTopup, waitForCustomerTopup } from '../../src/domain/payments/customer-status.js';
import { renderProjection } from '../../src/discord/renderers/projections.js';
import { encryptSecret } from '../../src/adapters/crypto/keyring.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

test('customer top-up status is ownership-bound and returns a credited result without waiting', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const receiverId = '019fc886-ffcd-70e3-bd14-fb61772e8401';
  const topupId = '019fc886-ffcd-70e3-bd14-fb61772e8402';
  const traceId = '019fc886-ffcd-70e3-bd14-fb61772e8403';
  const keyring = { current: 1, keys: { 1: Buffer.alloc(32, 7).toString('base64') } };
  const phone = encryptSecret('0812341234', keyring, `receiver:${receiverId}:guild`);
  await pool.query(`INSERT INTO receiver_versions(id,version,encrypted_phone,encryption_key_version,
    nonce,auth_tag,phone_last4,state,actor_id,trace_id)
    VALUES($1,1,$2,1,$3,$4,'1234','ACTIVE','owner',$5)`, [
    receiverId, phone.ciphertext, phone.nonce, phone.authTag, traceId,
  ]);
  await pool.query("INSERT INTO wallets(discord_user_id,available_cents) VALUES('customer',11000)");
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,amount_cents,bonus_cents,currency,trace_id,credited_at)
    VALUES($1,'customer','CREDITED',1,$2,$3,'1234',10000,1000,'THB',$4,clock_timestamp())`, [
    topupId, Buffer.from('voucher'), receiverId, traceId,
  ]);
  const sensitive = encryptSecret(JSON.stringify({ code: 'voucher-code',
    url: 'https://gift.truemoney.com/campaign/?v=voucher-code' }), keyring, `topup:${topupId}:guild`);
  await pool.query(`INSERT INTO topup_sensitive_payloads(topup_id,key_version,nonce,ciphertext,auth_tag)
    VALUES($1,$2,$3,$4,$5)`, [topupId, sensitive.keyVersion, sensitive.nonce, sensitive.ciphertext, sensitive.authTag]);

  const loaded = await loadCustomerTopup({ topupId, discordUserId: 'customer' }, { pool });
  assert.equal(loaded.status, 'CREDITED');
  assert.equal(loaded.wallet_available_cents, '11000');
  const settled = await waitForCustomerTopup({ topupId, discordUserId: 'customer', timeoutMs: 10 }, { pool });
  assert.equal(settled.id, topupId);
  const receipt = await renderProjection(pool, { projection_type: 'TOPUP_RECEIPT', aggregate_id: topupId });
  assert.match(receipt.embeds[0].data.description, /ได้รับทั้งหมด:\*\* 110\.00 บาท/);
  const paymentLog = await renderProjection(pool, { projection_type: 'PAYMENT_LOG', aggregate_id: topupId }, {
    env: { DATA_ENCRYPTION_KEYS_JSON: keyring, DISCORD_GUILD_ID: 'guild' },
    client: { users: { fetch: async () => null } },
  });
  assert.match(paymentLog.embeds[0].data.description, /gift\.truemoney\.com/);
  assert.match(paymentLog.embeds[0].data.description, /••••1234/);
  assert.doesNotMatch(paymentLog.embeds[0].data.description, /0812341234|Voucher Sender|0812345678/);
  await assert.rejects(() => loadCustomerTopup({ topupId, discordUserId: 'other' }, { pool }),
    (error) => error.code === 'NOT_AUTHORIZED');
});

test('customer can read a pending top-up before a wallet row exists', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const receiverId = '019fc886-ffcd-70e3-bd14-fb61772e8411';
  const topupId = '019fc886-ffcd-70e3-bd14-fb61772e8412';
  const traceId = '019fc886-ffcd-70e3-bd14-fb61772e8413';
  const keyring = { current: 1, keys: { 1: Buffer.alloc(32, 9).toString('base64') } };
  const phone = encryptSecret('0899991111', keyring, `receiver:${receiverId}:guild`);
  await pool.query(`INSERT INTO receiver_versions(id,version,encrypted_phone,encryption_key_version,
    nonce,auth_tag,phone_last4,state,actor_id,trace_id)
    VALUES($1,2,$2,1,$3,$4,'1111','INACTIVE','owner',$5)`, [
    receiverId, phone.ciphertext, phone.nonce, phone.authTag, traceId,
  ]);
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,trace_id)
    VALUES($1,'new-customer','PAYMENT_QUEUED',1,$2,$3,'1111',$4)`, [
    topupId, Buffer.from('pending-voucher'), receiverId, traceId,
  ]);

  const loaded = await loadCustomerTopup({ topupId, discordUserId: 'new-customer' }, { pool });
  assert.equal(loaded.status, 'PAYMENT_QUEUED');
  assert.equal(loaded.wallet_available_cents, '0');
  const wallet = await pool.query("SELECT 1 FROM wallets WHERE discord_user_id='new-customer'");
  assert.equal(wallet.rowCount, 0);
});
