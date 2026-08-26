import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { acquireRunnableJob, renewRunnerJob } from '../../src/domain/runner/service.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

test('fair queue gives a new user a slot before returning to a busy user', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const trace = uuidv7(); const rule = uuidv7();
  await pool.query(`INSERT INTO price_rules(id,rule_type,amount_cents,config_version,actor_id,trace_id)
    VALUES($1,'DEFAULT',500,1,'test',$2)`, [rule, trace]);
  const createJob = async (user, suffix) => {
    const order = uuidv7(); const item = uuidv7(); const job = uuidv7(); const quest = `fair-${suffix}`;
    await pool.query(`INSERT INTO quests(quest_id,analysis_state,name,task_type,task_target,url,expires_at)
      VALUES($1,'SUPPORTED',$1,'WATCH_VIDEO',60,'https://discord.com/quests/test',clock_timestamp()+interval '1 day')`, [quest]);
    await pool.query(`INSERT INTO orders(id,discord_user_id,account_id,trace_id) VALUES($1,$2,$3,$4)`, [order, user, `account-${suffix}`, trace]);
    await pool.query(`INSERT INTO order_items(id,order_id,sequence_number,quest_id,quest_name,task_type,
      price_cents,price_rule_id,config_version,metadata_revision,engine_version,executor_version,
      contract_version,runner_state_schema_version,state,deadline_at)
      VALUES($1,$2,1,$3,$3,'WATCH_VIDEO',500,$4,1,1,'1','1','1',1,'QUEUED',clock_timestamp()+interval '1 day')`,
    [item, order, quest, rule]);
    await pool.query(`INSERT INTO runner_jobs(id,order_item_id,discord_user_id,account_id,state,deadline_at,
      engine_version,executor_version,contract_version,runner_state_schema_version,trace_id)
      VALUES($1,$2,$3,$4,'QUEUED',clock_timestamp()+interval '1 day','1','1','1',1,$5)`,
    [job, item, user, `account-${suffix}`, trace]);
    await pool.query(`INSERT INTO scheduler_users(discord_user_id) VALUES($1) ON CONFLICT DO NOTHING`, [user]);
  };
  await createJob('user-a', 'a1'); await createJob('user-a', 'a2'); await createJob('user-b', 'b1');
  const context = (key) => createContext({ actorType: 'SYSTEM', actorId: key,
    guildId: '10000000000000002', idempotencyKey: key });
  const first = await acquireRunnableJob({ holder: uuidv7() }, context('fair-1'), { pool });
  const second = await acquireRunnableJob({ holder: uuidv7() }, context('fair-2'), { pool });
  assert.notEqual(first.discord_user_id, second.discord_user_id);
  await pool.query('UPDATE runner_jobs SET fencing_token=fencing_token+1 WHERE id=$1', [first.id]);
  await assert.rejects(() => renewRunnerJob(first, 60, { pool }), (error) => error.code === 'FENCING_LOST');
});

test('runner never claims a job whose pinned version tuple is unsupported', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  await pool.query("UPDATE runner_jobs SET state='COMPLETED'");
  const trace = uuidv7(); const rule = uuidv7(); const order = uuidv7();
  const item = uuidv7(); const job = uuidv7();
  await pool.query(`INSERT INTO price_rules(id,rule_type,amount_cents,config_version,actor_id,trace_id)
    VALUES($1,'DEFAULT',500,1,'test',$2)`, [rule, trace]);
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,name,task_type,task_target,url,expires_at)
    VALUES('incompatible-job','SUPPORTED','Unsupported version','WATCH_VIDEO',60,
      'https://discord.com/quests/test',clock_timestamp()+interval '1 day')`);
  await pool.query(`INSERT INTO orders(id,discord_user_id,account_id,trace_id)
    VALUES($1,'version-user','version-account',$2)`, [order, trace]);
  await pool.query(`INSERT INTO order_items(id,order_id,sequence_number,quest_id,quest_name,task_type,
    price_cents,price_rule_id,config_version,metadata_revision,engine_version,executor_version,
    contract_version,runner_state_schema_version,state,deadline_at)
    VALUES($1,$2,1,'incompatible-job','Unsupported version','WATCH_VIDEO',500,$3,1,1,
      '99.0.0','99.0.0','99.0.0',99,'QUEUED',clock_timestamp()+interval '1 day')`, [item, order, rule]);
  await pool.query(`INSERT INTO runner_jobs(id,order_item_id,discord_user_id,account_id,state,deadline_at,
    engine_version,executor_version,contract_version,runner_state_schema_version,trace_id)
    VALUES($1,$2,'version-user','version-account','QUEUED',clock_timestamp()+interval '1 day',
      '99.0.0','99.0.0','99.0.0',99,$3)`, [job, item, trace]);
  await pool.query("INSERT INTO scheduler_users(discord_user_id) VALUES('version-user') ON CONFLICT DO NOTHING");
  const context = createContext({ actorType: 'SYSTEM', actorId: 'version-worker', guildId: 'guild',
    idempotencyKey: 'unsupported-version-claim' });
  assert.equal(await acquireRunnableJob({ holder: uuidv7() }, context, { pool }), null);
  assert.equal((await pool.query('SELECT state FROM runner_jobs WHERE id=$1', [job])).rows[0].state, 'QUEUED');
});
