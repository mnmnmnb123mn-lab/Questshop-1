import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { acquireTestRun, renewQuestTestLease } from '../../src/workers/quest-test-worker.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

test('quest test acquisition is exclusive and stale fencing token cannot renew', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const questId = 'quest-test-lease'; const monitor = uuidv7(); const run = uuidv7(); const trace = uuidv7();
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,sale_state,name,task_type,task_target,url,
    expires_at,executor_id,engine_version,executor_version,contract_version)
    VALUES($1,'SUPPORTED','OPEN','Lease test','WATCH_VIDEO',60,'https://discord.com/quests/test',
    clock_timestamp()+interval '1 day','video','1','1','1')`, [questId]);
  await pool.query(`INSERT INTO monitor_accounts(id,account_id,username,capabilities,state)
    VALUES($1,'monitor-account','Monitor',ARRAY['TEST'],'ACTIVE')`, [monitor]);
  await pool.query(`INSERT INTO monitor_credentials(monitor_id,key_version,nonce,ciphertext,auth_tag)
    VALUES($1,1,$2,$3,$4)`, [monitor, Buffer.alloc(12), Buffer.alloc(32), Buffer.alloc(16)]);
  await pool.query(`INSERT INTO quest_test_runs(id,quest_id,state,engine_version,executor_version,
    contract_version,trace_id) VALUES($1,$2,'TEST_QUEUED','1','1','1',$3)`, [run, questId, trace]);
  const [first, duplicate] = await Promise.all([
    acquireTestRun({ holder: uuidv7(), pool }), acquireTestRun({ holder: uuidv7(), pool }),
  ]);
  const acquired = first ?? duplicate;
  assert.ok(acquired);
  assert.equal(first == null || duplicate == null, true);
  await pool.query(`UPDATE quest_test_runs SET state='TEST_QUEUED',lease_owner=NULL,
    lease_expires_at=NULL WHERE id=$1`, [run]);
  const replacement = await acquireTestRun({ holder: uuidv7(), pool });
  assert.ok(BigInt(replacement.run.fencing_token) > BigInt(acquired.run.fencing_token));
  await assert.rejects(() => renewQuestTestLease(acquired.run, { pool }),
    (error) => error.code === 'FENCING_LOST');
});

