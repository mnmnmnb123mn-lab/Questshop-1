import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { seedLeasedRunner } from '../fixtures/leased-runner.js';
import { processRunnerJob } from '../../src/domain/runner/service.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

test('recovery captures a reservation when a possibly-sent runner mutation is freshly verified as completed', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const fixture = await seedLeasedRunner(pool, { questId: 'recovery-quest', userId: 'recovery-user',
    accountId: 'recovery-account', attemptCount: 1 });
  const { trace, jobId, itemId, accountId, env, job, userId } = fixture;
  const priorAttemptId = uuidv7();
  await pool.query(`INSERT INTO runner_attempts(id,job_id,attempt_number,stage,trace_id)
    VALUES($1,$2,0,'PREVIOUS',$3)`, [priorAttemptId, jobId, trace]);
  await pool.query(`INSERT INTO runner_mutations(id,job_id,attempt_id,sequence_number,mutation_kind,status,
    baseline_progress,target_payload,request_hash,trace_id) VALUES($1,$2,$3,1,'VIDEO_PROGRESS','UNCERTAIN',
    0,$4,'test-hash',$5)`, [uuidv7(), jobId, priorAttemptId, { timestamp: 60 }, trace]);
  const completedQuest = { id: 'recovery-quest', completed: true, completedAt: new Date().toISOString(),
    progress: 100, progressSecs: 60, url: 'https://discord.com/quests/recovery-quest', enrolled: true };
  const result = await processRunnerJob(job, { env, options: { pool, questApiFactory: () => ({
    fetchCurrentUser: async () => ({ id: accountId }), fetchQuests: async () => [completedQuest],
  }) } });
  assert.equal(result.outcome, 'READY_TO_CLAIM');
  assert.equal(result.recovered, true);
  assert.equal((await pool.query('SELECT state FROM order_items WHERE id=$1', [itemId])).rows[0].state, 'READY_TO_CLAIM');
  assert.equal((await pool.query('SELECT state FROM wallet_reservations WHERE order_item_id=$1', [itemId])).rows[0].state,
    'CAPTURED');
  const wallet = (await pool.query('SELECT available_cents,reserved_cents FROM wallets WHERE discord_user_id=$1', [userId])).rows[0];
  assert.equal(BigInt(wallet.available_cents), 0n);
  assert.equal(BigInt(wallet.reserved_cents), 0n);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM wallet_transactions
    WHERE reference_id=$1 AND transaction_type='CAPTURE'`, [itemId])).rows[0].count), 1);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM wallet_transactions
    WHERE reference_id=$1 AND transaction_type='RELEASE'`, [itemId])).rows[0].count), 0);
});

test('recovery captures completion proven by a previously verified runner mutation', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const fixture = await seedLeasedRunner(pool, { questId: 'verified-recovery-quest',
    userId: 'verified-recovery-user', accountId: 'verified-recovery-account', attemptCount: 1 });
  const priorAttemptId = uuidv7();
  await pool.query(`INSERT INTO runner_attempts(id,job_id,attempt_number,stage,trace_id)
    VALUES($1,$2,0,'COMPLETION_VERIFIED',$3)`, [priorAttemptId, fixture.jobId, fixture.trace]);
  await pool.query(`INSERT INTO runner_mutations(id,job_id,attempt_id,sequence_number,mutation_kind,status,
    baseline_progress,target_payload,request_hash,evidence,trace_id,verified_at)
    VALUES($1,$2,$3,1,'VIDEO_PROGRESS','VERIFIED',0,$4,'test-hash',$5,$6,clock_timestamp())`,
  [uuidv7(), fixture.jobId, priorAttemptId, { timestamp: 60 },
    { completed: true, completedAt: new Date().toISOString() }, fixture.trace]);
  const completedQuest = { id: fixture.questId, completed: true, completedAt: new Date().toISOString(),
    progress: 100, progressSecs: 60, url: `https://discord.com/quests/${fixture.questId}`, enrolled: true };
  const result = await processRunnerJob(fixture.job, { env: fixture.env, options: { pool,
    questApiFactory: () => ({ fetchCurrentUser: async () => ({ id: fixture.accountId }),
      fetchQuests: async () => [completedQuest] }) } });
  assert.equal(result.outcome, 'READY_TO_CLAIM');
  assert.equal(result.recovered, true);
  assert.equal((await pool.query('SELECT state FROM wallet_reservations WHERE order_item_id=$1',
    [fixture.itemId])).rows[0].state, 'CAPTURED');
});

test('a completed Quest with missing provenance after execution remains reserved for Manual Review', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const fixture = await seedLeasedRunner(pool, { questId: 'ambiguous-recovery-quest',
    userId: 'ambiguous-recovery-user', accountId: 'ambiguous-recovery-account' });
  await pool.query(`UPDATE order_items SET started_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
    [fixture.itemId]);
  const completedQuest = { id: fixture.questId, completed: true, completedAt: new Date().toISOString(),
    progress: 100, progressSecs: 60, url: `https://discord.com/quests/${fixture.questId}`, enrolled: true };
  const result = await processRunnerJob(fixture.job, { env: fixture.env, options: { pool,
    questApiFactory: () => ({ fetchCurrentUser: async () => ({ id: fixture.accountId }),
      fetchQuests: async () => [completedQuest] }) } });
  assert.equal(result.outcome, 'MANUAL_REVIEW');
  assert.equal((await pool.query('SELECT state FROM wallet_reservations WHERE order_item_id=$1',
    [fixture.itemId])).rows[0].state, 'RESERVED');
  const wallet = (await pool.query(`SELECT available_cents,reserved_cents FROM wallets
    WHERE discord_user_id=$1`, [fixture.userId])).rows[0];
  assert.equal(BigInt(wallet.available_cents), 0n);
  assert.equal(BigInt(wallet.reserved_cents), fixture.amountCents);
});
