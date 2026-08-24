import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { adjustBalance, reserveOrderItems } from '../../src/domain/wallet/service.js';
import { settleRunnerRelease } from '../../src/domain/runner/service.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

test('terminal release atomically closes its Runner job and materializes exactly one later item', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const trace = uuidv7(); const owner = uuidv7(); const order = uuidv7(); const rule = uuidv7();
  const first = uuidv7(); const second = uuidv7(); const jobId = uuidv7(); const user = 'atomic-user';
  const context = createContext({ traceId: trace, actorType: 'SYSTEM', actorId: owner,
    guildId: '10000000000000002', idempotencyKey: `atomic-release:${first}` });
  await adjustBalance({ discordUserId: user, amountCents: 1_000n, reason: 'seed' }, context, { pool });
  await pool.query(`INSERT INTO price_rules(id,rule_type,amount_cents,config_version,actor_id,trace_id)
    VALUES($1,'DEFAULT',500,1,'owner',$2)`, [rule, trace]);
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,sale_state,name,task_type,task_target,url,
    starts_at,expires_at,executor_id) VALUES
    ('atomic-first','SUPPORTED','OPEN','Atomic first','WATCH_VIDEO',60,'https://discord.com/quests/atomic-first',
      clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day','video'),
    ('atomic-second','SUPPORTED','OPEN','Atomic second','WATCH_VIDEO',60,'https://discord.com/quests/atomic-second',
      clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day','video')`);
  await pool.query(`INSERT INTO orders(id,discord_user_id,account_id,trace_id)
    VALUES($1,$2,'atomic-account',$3)`, [order, user, trace]);
  for (const [id, sequence, questId] of [[first, 1, 'atomic-first'], [second, 2, 'atomic-second']]) {
    await pool.query(`INSERT INTO order_items(id,order_id,sequence_number,quest_id,quest_name,task_type,
      price_cents,price_rule_id,config_version,metadata_revision,engine_version,executor_version,
      contract_version,runner_state_schema_version,state,deadline_at)
      VALUES($1,$2,$3,$4,$4,'WATCH_VIDEO',500,$5,1,1,'1','1','1',1,'SELECTED',clock_timestamp()+interval '1 day')`,
    [id, order, sequence, questId, rule]);
  }
  await reserveOrderItems({ discordUserId: user, items: [
    { itemId: first, amountCents: 500n }, { itemId: second, amountCents: 500n },
  ] }, context, { pool });
  await pool.query(`UPDATE order_items SET state='LEASED',state_version=state_version+1 WHERE id=$1`, [first]);
  await pool.query(`INSERT INTO runner_jobs(id,order_item_id,discord_user_id,account_id,state,lease_owner,
    lease_expires_at,fencing_token,deadline_at,engine_version,executor_version,contract_version,
    runner_state_schema_version,trace_id) VALUES($1,$2,$3,'atomic-account','LEASED',$4,
      clock_timestamp()+interval '1 minute',1,clock_timestamp()+interval '1 day','1','1','1',1,$5)`,
  [jobId, first, user, owner, trace]);
  await settleRunnerRelease({ id: jobId, order_item_id: first, lease_owner: owner, fencing_token: 1,
    state: 'LEASED', state_version: 1 }, { terminalState: 'EXTERNAL_COMPLETED_RELEASED',
    reason: 'EXTERNAL_COMPLETED_BEFORE_START', orderId: order }, context, { pool });
  assert.equal((await pool.query('SELECT state FROM runner_jobs WHERE id=$1', [jobId])).rows[0].state, 'FAILED');
  assert.equal((await pool.query('SELECT state FROM order_items WHERE id=$1', [first])).rows[0].state,
    'EXTERNAL_COMPLETED_RELEASED');
  assert.equal((await pool.query('SELECT state FROM order_items WHERE id=$1', [second])).rows[0].state, 'QUEUED');
  assert.equal(Number((await pool.query('SELECT count(*)::integer AS count FROM runner_jobs WHERE order_item_id=$1',
    [second])).rows[0].count), 1);
  const wallet = (await pool.query('SELECT available_cents,reserved_cents FROM wallets WHERE discord_user_id=$1', [user])).rows[0];
  assert.equal(BigInt(wallet.available_cents), 500n);
  assert.equal(BigInt(wallet.reserved_cents), 500n);
});
