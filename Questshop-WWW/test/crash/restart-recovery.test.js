import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { runMaintenance } from '../../src/workers/maintenance-worker.js';
import { requeueDueRunnerJobs } from '../../src/domain/runner/service.js';
import { createContext } from '../../src/shared/correlation.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

test('restart recovery moves possibly-sent payment to Owner review without credit', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const receiver = uuidv7(); const topup = uuidv7(); const trace = uuidv7();
  await pool.query(`INSERT INTO receiver_versions(id,version,encrypted_phone,encryption_key_version,
    nonce,auth_tag,phone_last4,state,actor_id,trace_id) VALUES($1,1,$2,1,$3,$4,'1234','ACTIVE','owner',$5)`,
  [receiver, Buffer.alloc(10), Buffer.alloc(12), Buffer.alloc(16), trace]);
  await pool.query(`INSERT INTO topups(id,discord_user_id,status,voucher_hmac_version,voucher_hmac,
    receiver_version_id,receiver_phone_last4,lease_owner,lease_expires_at,fencing_token,trace_id)
    VALUES($1,'recovery-user','PROCESSING',1,$2,$3,'1234',$4,
      clock_timestamp()-interval '1 second',1,$5)`,
  [topup, Buffer.alloc(32, 7), receiver, uuidv7(), trace]);
  const guild = { members: { fetchMe: async () => ({ id: 'bot' }) }, roles: { everyone: { id: 'everyone' } } };
  const client = { questshop: {}, guilds: { fetch: async () => guild } };
  await runMaintenance({ env: { DISCORD_GUILD_ID: '10000000000000002', RUNNER_CONCURRENCY: 3 },
    holder: 'restart-test', client, pool });
  const recovered = (await pool.query('SELECT * FROM topups WHERE id=$1', [topup])).rows[0];
  assert.equal(recovered.status, 'MANUAL_REVIEW');
  assert.equal(recovered.failure_code, 'PROCESS_CRASH_AFTER_POSSIBLE_SEND');
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM wallet_transactions WHERE reference_id=$1',
    [topup])).rows[0].count), 0);
  const review = (await pool.query("SELECT * FROM manual_reviews WHERE subject_type='TOPUP' AND subject_id=$1",
    [topup])).rows[0];
  assert.equal(review.owner_only, true);
  assert.equal(review.trace_id, trace);
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM outbox_events o
    JOIN message_projections p ON p.id=o.projection_id WHERE p.projection_type='MANUAL_REVIEW'
    AND p.aggregate_id=$1`, [review.id])).rows[0].count), 1);
  const transitions = (await pool.query(`SELECT from_state,to_state FROM state_transitions
    WHERE aggregate_type='TOPUP' AND aggregate_id=$1 ORDER BY created_at`, [topup])).rows;
  assert.deepEqual(transitions, [
    { from_state: 'PROCESSING', to_state: 'AMBIGUOUS' },
    { from_state: 'AMBIGUOUS', to_state: 'MANUAL_REVIEW' },
  ]);
});

test('restart recovery records a failed Quest test attempt then queues a fresh attempt', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const run = uuidv7(); const trace = uuidv7();
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,sale_state,name,task_type,task_target,
    url,expires_at,executor_id) VALUES('recovery-quest','SUPPORTED','OPEN','Recovery Quest',
    'WATCH_VIDEO',60,'https://discord.com/quests/recovery',clock_timestamp()+interval '1 day','video')`);
  await pool.query(`INSERT INTO quest_test_runs(id,quest_id,state,engine_version,executor_version,
    contract_version,trace_id,lease_owner,lease_expires_at,fencing_token,started_at)
    VALUES($1,'recovery-quest','TESTING','1','1','1',$2,$3,
      clock_timestamp()-interval '1 second',1,clock_timestamp()-interval '1 minute')`,
  [run, trace, uuidv7()]);
  const guild = { members: { fetchMe: async () => ({ id: 'bot' }) }, roles: { everyone: { id: 'everyone' } } };
  const client = { questshop: {}, guilds: { fetch: async () => guild } };
  await runMaintenance({ env: { DISCORD_GUILD_ID: '10000000000000002', RUNNER_CONCURRENCY: 3 },
    holder: 'quest-restart-test', client, pool });
  assert.equal((await pool.query('SELECT state FROM quest_test_runs WHERE id=$1', [run])).rows[0].state,
    'TEST_FAILED');
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM quest_test_runs
    WHERE quest_id='recovery-quest' AND state='TEST_QUEUED'`)).rows[0].count), 1);
  assert.deepEqual((await pool.query(`SELECT from_state,to_state FROM state_transitions
    WHERE aggregate_type='QUEST_TEST' AND aggregate_id=$1`, [run])).rows, [
    { from_state: 'TESTING', to_state: 'TEST_FAILED' },
  ]);
});

test('restart recovery requeues an expired Runner lease with Job and Item transition evidence', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const trace = uuidv7(); const rule = uuidv7(); const order = uuidv7(); const item = uuidv7(); const job = uuidv7();
  await pool.query(`INSERT INTO price_rules(id,rule_type,amount_cents,config_version,actor_id,trace_id)
    VALUES($1,'DEFAULT',500,1,'owner',$2)`, [rule, trace]);
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,sale_state,name,task_type,task_target,url,expires_at)
    VALUES('expired-runner-lease','SUPPORTED','OPEN','Expired Runner Lease','WATCH_VIDEO',60,
      'https://discord.com/quests/expired-runner-lease',clock_timestamp()+interval '1 day')`);
  await pool.query(`INSERT INTO orders(id,discord_user_id,account_id,trace_id)
    VALUES($1,'recovery-runner-user','recovery-runner-account',$2)`, [order, trace]);
  await pool.query(`INSERT INTO order_items(id,order_id,sequence_number,quest_id,quest_name,task_type,
    price_cents,price_rule_id,config_version,metadata_revision,engine_version,executor_version,
    contract_version,runner_state_schema_version,state,deadline_at)
    VALUES($1,$2,1,'expired-runner-lease','Expired Runner Lease','WATCH_VIDEO',500,$3,1,1,'1','1','1',1,
      'LEASED',clock_timestamp()+interval '1 day')`, [item, order, rule]);
  await pool.query(`INSERT INTO runner_jobs(id,order_item_id,discord_user_id,account_id,state,lease_owner,
    lease_expires_at,fencing_token,deadline_at,engine_version,executor_version,contract_version,
    runner_state_schema_version,trace_id)
    VALUES($1,$2,'recovery-runner-user','recovery-runner-account','LEASED',$3,
      clock_timestamp()-interval '1 second',1,clock_timestamp()+interval '1 day','1','1','1',1,$4)`,
  [job, item, uuidv7(), trace]);
  const guild = { members: { fetchMe: async () => ({ id: 'bot' }) }, roles: { everyone: { id: 'everyone' } } };
  const client = { questshop: {}, guilds: { fetch: async () => guild } };
  await runMaintenance({ env: { DISCORD_GUILD_ID: '10000000000000002', RUNNER_CONCURRENCY: 3 },
    holder: 'runner-restart-test', client, pool });
  assert.equal((await pool.query('SELECT state FROM runner_jobs WHERE id=$1', [job])).rows[0].state, 'QUEUED');
  assert.equal((await pool.query('SELECT state FROM order_items WHERE id=$1', [item])).rows[0].state, 'QUEUED');
  const transitions = (await pool.query(`SELECT aggregate_type,from_state,to_state FROM state_transitions
    WHERE aggregate_id=ANY($1::text[]) ORDER BY aggregate_type`, [[job, item]])).rows;
  assert.deepEqual(transitions, [
    { aggregate_type: 'ORDER_ITEM', from_state: 'LEASED', to_state: 'QUEUED' },
    { aggregate_type: 'RUNNER_JOB', from_state: 'LEASED', to_state: 'QUEUED' },
  ]);
});

test('restart recovery checkpoints a crashed running Runner into bounded retry', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const trace = uuidv7(); const rule = uuidv7(); const order = uuidv7(); const item = uuidv7(); const job = uuidv7();
  await pool.query(`INSERT INTO price_rules(id,rule_type,amount_cents,config_version,actor_id,trace_id)
    VALUES($1,'DEFAULT',500,1,'owner',$2)`, [rule, trace]);
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,sale_state,name,task_type,task_target,url,expires_at)
    VALUES('crashed-running-recovery','SUPPORTED','OPEN','Crashed Running Recovery','WATCH_VIDEO',60,
      'https://discord.com/quests/crashed-running-recovery',clock_timestamp()+interval '1 day')`);
  await pool.query(`INSERT INTO orders(id,discord_user_id,account_id,trace_id)
    VALUES($1,'crashed-running-user','crashed-running-account',$2)`, [order, trace]);
  await pool.query(`INSERT INTO order_items(id,order_id,sequence_number,quest_id,quest_name,task_type,
    price_cents,price_rule_id,config_version,metadata_revision,engine_version,executor_version,
    contract_version,runner_state_schema_version,state,deadline_at)
    VALUES($1,$2,1,'crashed-running-recovery','Crashed Running Recovery','WATCH_VIDEO',500,$3,1,1,'1','1','1',1,
      'RUNNING',clock_timestamp()+interval '1 day')`, [item, order, rule]);
  await pool.query(`INSERT INTO runner_jobs(id,order_item_id,discord_user_id,account_id,state,lease_owner,
    lease_expires_at,fencing_token,deadline_at,engine_version,executor_version,contract_version,
    runner_state_schema_version,trace_id)
    VALUES($1,$2,'crashed-running-user','crashed-running-account','RUNNING',$3,
      clock_timestamp()-interval '1 second',1,clock_timestamp()+interval '1 day','1','1','1',1,$4)`,
  [job, item, uuidv7(), trace]);
  const guild = { members: { fetchMe: async () => ({ id: 'bot' }) }, roles: { everyone: { id: 'everyone' } } };
  const client = { questshop: {}, guilds: { fetch: async () => guild } };
  await runMaintenance({ env: { DISCORD_GUILD_ID: '10000000000000002', RUNNER_CONCURRENCY: 3 },
    holder: 'crashed-running-recovery-test', client, pool });
  const recoveredJob = (await pool.query('SELECT state,available_at FROM runner_jobs WHERE id=$1', [job])).rows[0];
  assert.equal(recoveredJob.state, 'WAITING_RETRY');
  assert.ok(new Date(recoveredJob.available_at).getTime() > Date.now());
  assert.equal((await pool.query('SELECT state FROM order_items WHERE id=$1', [item])).rows[0].state, 'WAITING_RETRY');
  assert.deepEqual((await pool.query(`SELECT aggregate_type,from_state,to_state FROM state_transitions
    WHERE aggregate_id=ANY($1::text[]) ORDER BY aggregate_type`, [[job, item]])).rows, [
    { aggregate_type: 'ORDER_ITEM', from_state: 'RUNNING', to_state: 'WAITING_RETRY' },
    { aggregate_type: 'RUNNER_JOB', from_state: 'RUNNING', to_state: 'WAITING_RETRY' },
  ]);
});

test('restart recovery requeues a rate-limited Runner job after Retry-After', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const trace = uuidv7(); const rule = uuidv7(); const order = uuidv7(); const item = uuidv7(); const job = uuidv7();
  await pool.query(`INSERT INTO price_rules(id,rule_type,amount_cents,config_version,actor_id,trace_id)
    VALUES($1,'DEFAULT',500,1,'owner',$2)`, [rule, trace]);
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,sale_state,name,task_type,task_target,
    url,expires_at) VALUES('rate-limit-recovery','SUPPORTED','CLOSED','Rate Limit Recovery','WATCH_VIDEO',60,
      'https://discord.com/quests/rate-limit-recovery',clock_timestamp()+interval '1 day')`);
  await pool.query(`INSERT INTO orders(id,discord_user_id,account_id,trace_id)
    VALUES($1,'rate-recovery-user','rate-recovery-account',$2)`, [order, trace]);
  await pool.query(`INSERT INTO order_items(id,order_id,sequence_number,quest_id,quest_name,task_type,
    price_cents,price_rule_id,config_version,metadata_revision,engine_version,executor_version,
    contract_version,runner_state_schema_version,state,deadline_at)
    VALUES($1,$2,1,'rate-limit-recovery','Rate Limit Recovery','WATCH_VIDEO',500,$3,1,1,'1','1','1',1,
      'WAITING_RATE_LIMIT',clock_timestamp()+interval '1 day')`, [item, order, rule]);
  await pool.query(`INSERT INTO runner_jobs(id,order_item_id,discord_user_id,account_id,state,available_at,
    deadline_at,engine_version,executor_version,contract_version,runner_state_schema_version,trace_id)
    VALUES($1,$2,'rate-recovery-user','rate-recovery-account','WAITING_RATE_LIMIT',clock_timestamp()-interval '1 second',
      clock_timestamp()+interval '1 day','1','1','1',1,$3)`, [job, item, trace]);
  await requeueDueRunnerJobs(createContext({ actorType: 'SYSTEM', actorId: 'runner-test',
    guildId: '10000000000000002', traceId: trace, idempotencyKey: `rate-requeue:${job}` }), { pool });
  const guild = { members: { fetchMe: async () => ({ id: 'bot' }) }, roles: { everyone: { id: 'everyone' } } };
  const client = { questshop: {}, guilds: { fetch: async () => guild } };
  await runMaintenance({ env: { DISCORD_GUILD_ID: '10000000000000002', RUNNER_CONCURRENCY: 3 },
    holder: 'rate-limit-recovery-test', client, pool });
  assert.equal((await pool.query('SELECT state FROM runner_jobs WHERE id=$1', [job])).rows[0].state, 'QUEUED');
  assert.equal((await pool.query('SELECT state FROM order_items WHERE id=$1', [item])).rows[0].state, 'QUEUED');
  assert.deepEqual((await pool.query(`SELECT aggregate_type,from_state,to_state FROM state_transitions
    WHERE aggregate_id=ANY($1::text[]) ORDER BY aggregate_type`, [[job, item]])).rows, [
    { aggregate_type: 'ORDER_ITEM', from_state: 'WAITING_RATE_LIMIT', to_state: 'QUEUED' },
    { aggregate_type: 'RUNNER_JOB', from_state: 'WAITING_RATE_LIMIT', to_state: 'QUEUED' },
  ]);
});
