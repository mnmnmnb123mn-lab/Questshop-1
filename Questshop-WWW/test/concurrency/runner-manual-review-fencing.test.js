import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { moveRunnerToManualReview } from '../../src/domain/runner/service.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

async function seedRunningJob(name, owner = uuidv7(), fencing = 1) {
  const trace = uuidv7(); const rule = uuidv7(); const order = uuidv7(); const item = uuidv7(); const job = uuidv7();
  await pool.query(`INSERT INTO price_rules(id,rule_type,amount_cents,config_version,actor_id,trace_id)
    VALUES($1,'DEFAULT',500,1,'test',$2)`, [rule, trace]);
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,sale_state,name,task_type,task_target,url,expires_at)
    VALUES($1,'SUPPORTED','OPEN',$1,'WATCH_VIDEO',60,'https://discord.com/quests/test',
      clock_timestamp()+interval '1 day')`, [name]);
  await pool.query(`INSERT INTO orders(id,discord_user_id,account_id,trace_id)
    VALUES($1,$2,$3,$4)`, [order, `review-user-${name}`, `review-account-${name}`, trace]);
  await pool.query(`INSERT INTO order_items(id,order_id,sequence_number,quest_id,quest_name,task_type,
    price_cents,price_rule_id,config_version,metadata_revision,engine_version,executor_version,
    contract_version,runner_state_schema_version,state,deadline_at)
    VALUES($1,$2,1,$3,$3,'WATCH_VIDEO',500,$4,1,1,'1','1','1',1,'RUNNING',
      clock_timestamp()+interval '1 day')`, [item, order, name, rule]);
  const row = (await pool.query(`INSERT INTO runner_jobs(id,order_item_id,discord_user_id,account_id,state,
    lease_owner,lease_expires_at,fencing_token,deadline_at,engine_version,executor_version,
    contract_version,runner_state_schema_version,trace_id)
    VALUES($1,$2,$3,$4,'RUNNING',$5,clock_timestamp()+interval '1 minute',$6,
      clock_timestamp()+interval '1 day','1','1','1',1,$7) RETURNING *`,
  [job, item, `review-user-${name}`, `review-account-${name}`, owner, fencing, trace])).rows[0];
  return { row, item, name, trace };
}

function context(key, traceId) {
  return createContext({ actorType: 'SYSTEM', actorId: 'runner-worker', guildId: 'guild', traceId,
    idempotencyKey: key });
}

test('stale Runner fencing cannot move a newer leased job into Manual Review', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const seeded = await seedRunningJob('stale-review');
  const old = { ...seeded.row, lease_owner: uuidv7(), fencing_token: 0 };
  await assert.rejects(() => moveRunnerToManualReview(old, context('stale-manual', seeded.trace), { pool },
    Object.assign(new Error('ambiguous'), { code: 'MUTATION_AMBIGUOUS' }), false),
  (error) => error.code === 'FENCING_LOST');
  assert.equal((await pool.query('SELECT state FROM runner_jobs WHERE id=$1', [seeded.row.id])).rows[0].state, 'RUNNING');
  assert.equal((await pool.query('SELECT state FROM order_items WHERE id=$1', [seeded.item])).rows[0].state, 'RUNNING');
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM manual_reviews
    WHERE subject_type='ORDER_ITEM' AND subject_id=$1`, [seeded.item])).rows[0].count), 0);
});

test('owned contract failure enters review, pauses sale, and records durable transitions', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const seeded = await seedRunningJob('contract-review');
  const failure = Object.assign(new Error('contract changed'), {
    code: 'EXECUTOR_INCOMPATIBLE', name: 'QuestCompatibilityError',
  });
  await moveRunnerToManualReview(seeded.row, context('owned-manual', seeded.trace), { pool }, failure, true);
  assert.equal((await pool.query('SELECT state FROM runner_jobs WHERE id=$1', [seeded.row.id])).rows[0].state,
    'MANUAL_REVIEW');
  assert.equal((await pool.query('SELECT state FROM order_items WHERE id=$1', [seeded.item])).rows[0].state,
    'MANUAL_REVIEW');
  assert.equal((await pool.query('SELECT sale_state FROM quests WHERE quest_id=$1', [seeded.name])).rows[0].sale_state,
    'PAUSED');
  const transitions = (await pool.query(`SELECT aggregate_type,to_state FROM state_transitions
    WHERE aggregate_id=ANY($1::text[]) ORDER BY aggregate_type`, [[seeded.row.id, seeded.item, seeded.name]])).rows;
  assert.deepEqual(transitions, [
    { aggregate_type: 'ORDER_ITEM', to_state: 'MANUAL_REVIEW' },
    { aggregate_type: 'QUEST_SALE', to_state: 'PAUSED' },
    { aggregate_type: 'RUNNER_JOB', to_state: 'MANUAL_REVIEW' },
  ]);
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM manual_reviews
    WHERE subject_type='ORDER_ITEM' AND subject_id=$1 AND state='OPEN'`, [seeded.item])).rows[0].count), 1);
});
