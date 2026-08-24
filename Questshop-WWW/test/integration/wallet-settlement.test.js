import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createContext } from '../../src/shared/correlation.js';
import {
  adjustBalance, captureReservation, refundCapturedOrderItem, releaseReservation, reserveOrderItems,
} from '../../src/domain/wallet/service.js';
import { createTestPool } from '../fixtures/postgres.js';
import { adjustWalletAsAdmin } from '../../src/domain/admin/money-service.js';
import { runRetention } from '../../src/workers/retention-worker.js';
import { evaluateAlerts } from '../../src/workers/alert-worker.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });
const context = (key) => createContext({ actorType: 'OWNER', actorId: '10000000000000001', guildId: '10000000000000002', idempotencyKey: key });

test('five items capture three and release two without losing cents', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const user = '10000000000000003';
  await adjustBalance({ discordUserId: user, amountCents: 5_000n, reason: 'test seed' }, context('seed'), { pool });
  const orderId = uuidv7();
  const ruleId = uuidv7();
  const trace = uuidv7();
  const itemIds = Array.from({ length: 5 }, () => uuidv7());
  await pool.query(`INSERT INTO price_rules(id,rule_type,amount_cents,config_version,actor_id,trace_id)
    VALUES($1,'DEFAULT',500,1,'test',$2)`, [ruleId, trace]);
  await pool.query(`INSERT INTO orders(id,discord_user_id,account_id,trace_id) VALUES($1,$2,'account-test',$3)`, [orderId, user, trace]);
  for (let index = 0; index < itemIds.length; index += 1) {
    const questId = `quest-${index}`;
    await pool.query(`INSERT INTO quests(quest_id,analysis_state,name,task_type,task_target,url,expires_at)
      VALUES($1,'SUPPORTED',$1,'WATCH_VIDEO',60,'https://discord.com/quests/test',clock_timestamp()+interval '1 day')`, [questId]);
    await pool.query(`INSERT INTO order_items(id,order_id,sequence_number,quest_id,quest_name,task_type,
      price_cents,price_rule_id,config_version,metadata_revision,engine_version,executor_version,
      contract_version,runner_state_schema_version,state,deadline_at)
      VALUES($1,$2,$3,$4,$4,'WATCH_VIDEO',500,$5,1,1,'1','1','1',1,'SELECTED',clock_timestamp()+interval '1 day')`,
    [itemIds[index], orderId, index + 1, questId, ruleId]);
  }
  await reserveOrderItems({ discordUserId: user, items: itemIds.map((itemId) => ({ itemId, amountCents: 500n })) }, context('reserve'), { pool });
  await pool.query(`UPDATE order_items SET state='SETTLING',started_at=clock_timestamp()-interval '1 minute'
    WHERE id=ANY($1::uuid[])`, [itemIds.slice(0, 3)]);
  await pool.query(`UPDATE order_items SET state='RUNNING',started_at=clock_timestamp()-interval '1 minute'
    WHERE id=ANY($1::uuid[])`, [itemIds.slice(3)]);
  await Promise.all(itemIds.slice(0, 3).map((orderItemId, index) => captureReservation({ orderItemId,
    claimUrl: `https://discord.com/quests/${index}` }, context(`capture-${index}`), { pool })));
  await Promise.all(itemIds.slice(3).map((orderItemId, index) => releaseReservation({ orderItemId,
    terminalState: 'FAILED_RELEASED', reason: 'TEST_FAILURE' }, context(`release-${index}`), { pool })));
  const wallet = (await pool.query('SELECT * FROM wallets WHERE discord_user_id = $1', [user])).rows[0];
  assert.equal(BigInt(wallet.available_cents), 3_500n);
  assert.equal(BigInt(wallet.reserved_cents), 0n);
  const counts = (await pool.query(`SELECT state,count(*)::integer AS count FROM wallet_reservations GROUP BY state`)).rows;
  assert.deepEqual(Object.fromEntries(counts.map((row) => [row.state, row.count])), { CAPTURED: 3, RELEASED: 2 });
  const samples = (await pool.query(`SELECT successful,count(*)::integer AS count FROM runtime_samples
    GROUP BY successful`)).rows;
  assert.deepEqual(Object.fromEntries(samples.map((row) => [String(row.successful), row.count])),
    { true: 3, false: 2 });

  const reservationVersion = (await pool.query(`SELECT state_version FROM wallet_reservations
    WHERE order_item_id=$1`, [itemIds[0]])).rows[0].state_version;
  const refundContext = context('captured-item-refund');
  const [firstRefund, repeatedRefund] = await Promise.all([
    refundCapturedOrderItem({ orderItemId: itemIds[0], reason: 'approved service refund',
      expectedReservationVersion: reservationVersion }, refundContext, { pool }),
    refundCapturedOrderItem({ orderItemId: itemIds[0], reason: 'approved service refund',
      expectedReservationVersion: reservationVersion }, context('captured-item-refund-repeat'), { pool }),
  ]);
  assert.equal(firstRefund.id, repeatedRefund.id);
  const refundedWallet = (await pool.query('SELECT * FROM wallets WHERE discord_user_id=$1', [user])).rows[0];
  assert.equal(BigInt(refundedWallet.available_cents), 4_000n);
  assert.equal(BigInt(refundedWallet.reserved_cents), 0n);
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM refunds WHERE order_item_id=$1',
    [itemIds[0]])).rows[0].count), 1);
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM wallet_transactions
    WHERE transaction_type='REFUND_CREDIT' AND metadata->>'orderItemId'=$1`, [itemIds[0]])).rows[0].count), 1);
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM admin_audit_logs
    WHERE action='ORDER_ITEM_REFUND' AND target_id=$1`, [itemIds[0]])).rows[0].count), 1);
});

test('concurrent debit cannot make wallet negative', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const user = '10000000000000004';
  await adjustBalance({ discordUserId: user, amountCents: 100n, reason: 'seed' }, context('concurrent-seed'), { pool });
  const results = await Promise.allSettled([
    adjustBalance({ discordUserId: user, amountCents: -80n, reason: 'one' }, context('debit-one'), { pool }),
    adjustBalance({ discordUserId: user, amountCents: -80n, reason: 'two' }, context('debit-two'), { pool }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const wallet = (await pool.query('SELECT available_cents FROM wallets WHERE discord_user_id = $1', [user])).rows[0];
  assert.equal(BigInt(wallet.available_cents), 20n);
});

test('admin wallet adjustment requires preview version and appends audit', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const user = '10000000000000005';
  const ctx = context('admin-adjust');
  const wallet = await adjustWalletAsAdmin({ discordUserId: user, amountCents: 250n,
    expectedVersion: 0, reason: 'approved test adjustment' }, ctx, { pool });
  assert.equal(BigInt(wallet.available_cents), 250n);
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM admin_audit_logs
    WHERE target_type='WALLET' AND target_id=$1`, [user])).rows[0].count), 1);
  await assert.rejects(() => adjustWalletAsAdmin({ discordUserId: user, amountCents: 100n,
    expectedVersion: 0, reason: 'stale preview' }, context('stale-admin-adjust'), { pool }),
  /STALE_WALLET_PREVIEW/);
});

test('ledger retention creates a hashed balance checkpoint before pruning detail', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const user = '10000000000000006';
  await adjustBalance({ discordUserId: user, amountCents: 100n, reason: 'old one' }, context('old-one'), { pool });
  await adjustBalance({ discordUserId: user, amountCents: 50n, reason: 'old two' }, context('old-two'), { pool });
  await pool.query(`UPDATE wallet_transactions SET created_at=clock_timestamp()-interval '2 years'
    +CASE WHEN idempotency_key='old-two' THEN interval '1 second' ELSE interval '0 seconds' END
    WHERE discord_user_id=$1`, [user]);
  const oldAudit = uuidv7();
  await pool.query(`INSERT INTO admin_audit_logs(id,action,target_type,target_id,actor_id,reason,
    trace_id,correlation_code,created_at) VALUES($1,'RETENTION_TEST','TEST',$2,'owner','expired detail',
    $3,'RETENTION',clock_timestamp()-interval '2 years')`, [oldAudit, user, uuidv7()]);
  await pool.query("UPDATE feature_gates SET enabled=true WHERE gate='RETENTION_JOBS_ENABLED'");
  const result = await runRetention({ pool });
  assert.equal(result.ledgerDeleted >= 2, true);
  assert.equal(Number(result.operational.adminAudits), 1);
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM admin_audit_logs WHERE id=$1',
    [oldAudit])).rows[0].count), 0);
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM wallet_transactions WHERE discord_user_id=$1',
    [user])).rows[0].count), 0);
  const checkpoint = (await pool.query(`SELECT * FROM wallet_checkpoints WHERE discord_user_id=$1
    ORDER BY created_at DESC LIMIT 1`, [user])).rows[0];
  assert.equal(BigInt(checkpoint.available_cents), 150n);
  assert.match(checkpoint.chain_hash, /^[a-f0-9]{64}$/);
  const wallet = (await pool.query('SELECT * FROM wallets WHERE discord_user_id=$1', [user])).rows[0];
  assert.equal(BigInt(wallet.available_cents), 150n);
  await adjustBalance({ discordUserId: user, amountCents: 25n, reason: 'post checkpoint' },
    context('post-checkpoint'), { pool });
  const nextLedger = (await pool.query(`SELECT * FROM wallet_transactions
    WHERE discord_user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, [user])).rows[0];
  assert.equal(nextLedger.previous_hash, checkpoint.chain_hash);
});

test('financial invariant alert opens and resolves without mutating ledger evidence', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const user = '10000000000000007';
  await adjustBalance({ discordUserId: user, amountCents: 500n, reason: 'alert seed' },
    context('alert-seed'), { pool });
  await pool.query('UPDATE wallets SET available_cents=499 WHERE discord_user_id=$1', [user]);
  const health = { ready: true, status: 'HEALTHY', workers: {} };
  await evaluateAlerts({ pool, health });
  assert.equal((await pool.query(`SELECT state FROM incidents WHERE incident_code='FINANCIAL_INVARIANT'
    AND scope='WALLET_LEDGER'`)).rows[0].state, 'OPEN');
  assert.equal(health.status, 'INCIDENT');
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM wallet_transactions
    WHERE discord_user_id=$1`, [user])).rows[0].count), 1);
  await pool.query('UPDATE wallets SET available_cents=500 WHERE discord_user_id=$1', [user]);
  await evaluateAlerts({ pool, health });
  assert.equal((await pool.query(`SELECT state FROM incidents WHERE incident_code='FINANCIAL_INVARIANT'
    AND scope='WALLET_LEDGER' ORDER BY opened_at DESC LIMIT 1`)).rows[0].state, 'RESOLVED');
});

test('Aiven-managed alert evaluation skips local backup tables and clears no backup health requirement', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const queries = [];
  const aivenPool = {
    query(sql, values) {
      queries.push(String(sql));
      return pool.query(sql, values);
    },
    connect() {
      return pool.connect();
    },
  };
  const health = { ready: true, status: 'HEALTHY', workers: {} };
  await evaluateAlerts({ pool: aivenPool, health, env: { BACKUP_MODE: 'AIVEN_MANAGED' } });
  assert.equal(health.overview.backupMode, 'AIVEN_MANAGED');
  assert.equal(queries.some((sql) => /backup_runs|restore_drills/.test(sql)), false);
});

test('scheduler lag opens a scoped incident without changing queued work', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const trace = uuidv7(); const rule = uuidv7(); const order = uuidv7(); const item = uuidv7(); const job = uuidv7();
  await pool.query(`INSERT INTO price_rules(id,rule_type,amount_cents,config_version,actor_id,trace_id)
    VALUES($1,'DEFAULT',500,1,'owner',$2)`, [rule, trace]);
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,name,task_type,task_target,url,expires_at)
    VALUES('scheduler-lag','SUPPORTED','Scheduler Lag','WATCH_VIDEO',60,
      'https://discord.com/quests/scheduler-lag',clock_timestamp()+interval '1 day')`);
  await pool.query(`INSERT INTO orders(id,discord_user_id,account_id,trace_id)
    VALUES($1,'scheduler-user','scheduler-account',$2)`, [order, trace]);
  await pool.query(`INSERT INTO order_items(id,order_id,sequence_number,quest_id,quest_name,task_type,
    price_cents,price_rule_id,config_version,metadata_revision,engine_version,executor_version,
    contract_version,runner_state_schema_version,state,deadline_at)
    VALUES($1,$2,1,'scheduler-lag','Scheduler Lag','WATCH_VIDEO',500,$3,1,1,'1','1','1',1,
      'QUEUED',clock_timestamp()+interval '1 day')`, [item, order, rule]);
  await pool.query(`INSERT INTO runner_jobs(id,order_item_id,discord_user_id,account_id,state,available_at,
    deadline_at,engine_version,executor_version,contract_version,runner_state_schema_version,trace_id)
    VALUES($1,$2,'scheduler-user','scheduler-account','QUEUED',clock_timestamp()-interval '6 seconds',
      clock_timestamp()+interval '1 day','1','1','1',1,$3)`, [job, item, trace]);
  const health = { ready: true, status: 'HEALTHY', workers: {} };
  await evaluateAlerts({ pool, health });
  assert.equal((await pool.query(`SELECT state FROM incidents WHERE incident_code='SCHEDULER_LAG'
    AND scope='RUNNER'`)).rows[0].state, 'OPEN');
  assert.equal((await pool.query('SELECT state FROM runner_jobs WHERE id=$1', [job])).rows[0].state, 'QUEUED');
  assert.equal(health.status, 'DEGRADED');
});
