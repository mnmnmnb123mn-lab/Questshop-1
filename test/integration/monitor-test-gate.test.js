import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { withTransaction } from '../../src/db/transaction.js';
import { createContext } from '../../src/shared/correlation.js';
import { ingestDiscovery } from '../../src/domain/catalog/service.js';
import {
  advanceMonitorTestBatch,
  markMonitorTestBatchPassed,
  reconcileFailedMonitorTestBatches,
  reconcilePassedMonitorTestBatches,
} from '../../src/domain/catalog/test-gate.js';
import { forcePublishFailedMonitorTest } from '../../src/domain/admin/operations-service.js';
import { openReview, resolveSubjectReview } from '../../src/domain/reviews/service.js';
import { questContractHash } from '../../src/quest-engine/schema/contract.js';
import { handleTestFailure } from '../../src/workers/quest-test-worker.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function normalized(id) {
  const quest = {
    id, name: `Quest ${id}`, eventName: 'WATCH_VIDEO', secondsNeeded: 60,
    startsAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ONE_DAY_MS).toISOString(),
    url: `https://discord.com/quests/${id}`, artworkUrl: null, orbs: 10,
    applicationId: `app-${id}`, progressKey: 'video', executorId: 'video', autoSupported: true,
    coreComplete: true, compatibilityIssues: [],
  };
  const contract = questContractHash(quest, { engineVersion: '1.0.0', executorVersion: '1.0.0',
    contractVersion: '1.0.0' });
  return { ...quest, contractHash: contract.hash, contractComplete: contract.complete };
}

test('Monitor discovery stays private until a batch passes; exhausted monitors create an auditable override', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const traceId = uuidv7();
  const context = createContext({ traceId, actorType: 'SYSTEM', actorId: 'scanner', guildId: 'guild', idempotencyKey: 'monitor-gate' });
  await pool.query(`INSERT INTO price_rules(id,rule_type,amount_cents,config_version,actor_id,trace_id)
    VALUES($1,'DEFAULT',500,1,'owner',$2)`, [uuidv7(), traceId]);
  const monitorOne = uuidv7(); const monitorTwo = uuidv7();
  await pool.query(`INSERT INTO monitor_accounts(id,account_id,capabilities,state,priority) VALUES
    ($1,'monitor-one',ARRAY['TEST'],'ACTIVE',10),($2,'monitor-two',ARRAY['TEST'],'ACTIVE',5)`, [monitorOne, monitorTwo]);

  await ingestDiscovery({ normalized: normalized('monitor-gated'), source: 'MONITOR' }, context, { pool });
  assert.equal((await pool.query("SELECT sale_state FROM quests WHERE quest_id='monitor-gated'")).rows[0].sale_state, 'CLOSED');
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM message_projections
    WHERE projection_type='QUEST_NEW' AND aggregate_id='monitor-gated'`)).rows[0].count), 0);

  // Fail three attempts on the first Monitor, then three on the second. The
  // batch service owns selection and stops at the first possible success.
  for (let index = 0; index < 6; index += 1) {
    const run = (await pool.query(`SELECT * FROM quest_test_runs WHERE batch_id=(SELECT id FROM quest_test_batches
      WHERE quest_id='monitor-gated' ORDER BY created_at DESC LIMIT 1) ORDER BY created_at DESC LIMIT 1`)).rows[0];
    await pool.query("UPDATE quest_test_runs SET state='TEST_FAILED',completed_at=clock_timestamp() WHERE id=$1", [run.id]);
    await withTransaction({ pool, isolation: 'SERIALIZABLE' }, async (client) => {
      const quest = (await client.query("SELECT * FROM quests WHERE quest_id='monitor-gated' FOR UPDATE")).rows[0];
      await advanceMonitorTestBatch(client, { run, quest,
        error: { code: 'TEST_MUTATION_NOT_VERIFIED', message: `attempt ${index + 1} did not verify` }, context });
    });
  }
  const alert = (await pool.query("SELECT * FROM quest_test_failure_alerts WHERE quest_id='monitor-gated'")).rows[0];
  assert.equal(alert.state, 'OPEN');
  const forced = await forcePublishFailedMonitorTest({ alertId: alert.id, reason: 'operator verified external evidence' },
    { ...context, actorType: 'ADMIN', actorId: 'admin' }, { pool });
  assert.equal(forced.quest.sale_state, 'OPEN');
  assert.equal((await pool.query("SELECT public_test_gate_override FROM quests WHERE quest_id='monitor-gated'"))
    .rows[0].public_test_gate_override, true);

  await ingestDiscovery({ normalized: normalized('monitor-passed'), source: 'MONITOR' }, context, { pool });
  const passRun = (await pool.query(`SELECT * FROM quest_test_runs WHERE quest_id='monitor-passed'
    ORDER BY created_at DESC LIMIT 1`)).rows[0];
  await pool.query("UPDATE quest_test_runs SET state='TEST_PASSED',completed_at=clock_timestamp() WHERE id=$1", [passRun.id]);
  await withTransaction({ pool, isolation: 'SERIALIZABLE' },
    (client) => markMonitorTestBatchPassed(client, { run: passRun, context }));
  await ingestDiscovery({ normalized: normalized('monitor-passed'), source: 'MONITOR' }, context, { pool });
  assert.equal((await pool.query("SELECT sale_state FROM quests WHERE quest_id='monitor-passed'")).rows[0].sale_state, 'OPEN');
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM message_projections
    WHERE projection_type='QUEST_NEW' AND aggregate_id='monitor-passed'`)).rows[0].count), 1);
});

test('Admin retry resolves a Quest Manual Review by seeding a fresh test batch', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const traceId = uuidv7();
  const context = createContext({ traceId, actorType: 'ADMIN', actorId: 'admin', guildId: 'guild',
    idempotencyKey: 'quest-review-retry' });
  const monitor = uuidv7(); const failedBatch = uuidv7(); const manualRun = uuidv7();
  await pool.query(`INSERT INTO monitor_accounts(id,account_id,capabilities,state,priority)
    VALUES($1,'retry-monitor',ARRAY['TEST'],'ACTIVE',1)`, [monitor]);
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,name,task_type,task_target,url,expires_at,
    executor_id,engine_version,executor_version,contract_version)
    VALUES('quest-review-retry','SUPPORTED','Quest review retry','WATCH_VIDEO',60,
      'https://discord.com/quests/quest-review-retry',clock_timestamp()+interval '1 day','video','1','1','1')`);
  await pool.query(`INSERT INTO quest_test_batches(id,quest_id,state,monitor_order,trace_id,requested_by,
    completed_at) VALUES($1,'quest-review-retry','FAILED',ARRAY[$2]::uuid[],$3,'SYSTEM',clock_timestamp())`,
  [failedBatch, monitor, traceId]);
  await pool.query(`INSERT INTO quest_test_runs(id,quest_id,batch_id,target_monitor_id,state,engine_version,
    executor_version,contract_version,attempt_in_monitor,trace_id,error_class,completed_at)
    VALUES($1,'quest-review-retry',$2,$3,'MANUAL_REVIEW','1','1','1',1,$4,'TEST_WORKER_CRASH',clock_timestamp())`,
  [manualRun, failedBatch, monitor, traceId]);
  const review = await withTransaction({ pool, isolation: 'SERIALIZABLE' }, (client) => openReview(client, {
    subjectType: 'QUEST', subjectId: 'quest-review-retry', reason: 'uncertain monitor mutation', context,
  }));
  const result = await resolveSubjectReview({ reviewId: review.id, decision: 'RETRY',
    reason: 'operator approved a clean Monitor retest', isOwner: false,
    expectedVersion: review.state_version }, context, { pool });
  assert.equal(result.review.state, 'RESOLVED');
  assert.equal(result.applied.status, 'TEST_QUEUED');
  assert.notEqual(result.applied.batchId, failedBatch);
  assert.equal((await pool.query('SELECT state FROM quest_test_runs WHERE id=$1', [manualRun])).rows[0].state,
    'MANUAL_REVIEW');
  const queued = (await pool.query(`SELECT * FROM quest_test_runs WHERE id=$1`, [result.applied.testRunId])).rows[0];
  assert.equal(queued.state, 'TEST_QUEUED');
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM monitor_accounts
    WHERE id=$1 AND state='ACTIVE' AND 'TEST'=ANY(capabilities)`, [queued.target_monitor_id])).rows[0].count), 1);
  assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM state_transitions
    WHERE aggregate_type='QUEST_TEST_BATCH' AND aggregate_id=$1 AND to_state='RUNNING'`,
  [result.applied.batchId])).rows[0].count, 1);
});

test('Admin retry closes an expired Quest review without creating a new test batch', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const traceId = uuidv7();
  const context = createContext({ traceId, actorType: 'ADMIN', actorId: 'admin', guildId: 'guild',
    idempotencyKey: 'expired-quest-review-retry' });
  const manualRun = uuidv7();
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,name,task_type,task_target,url,expires_at,
    executor_id,engine_version,executor_version,contract_version)
    VALUES('expired-quest-review','SUPPORTED','Expired review','WATCH_VIDEO',60,
      'https://discord.com/quests/expired-quest-review',clock_timestamp()-interval '1 second','video','1','1','1')`);
  await pool.query(`INSERT INTO quest_test_runs(id,quest_id,state,engine_version,executor_version,
    contract_version,attempt_in_monitor,trace_id,error_class,completed_at)
    VALUES($1,'expired-quest-review','MANUAL_REVIEW','1','1','1',1,$2,'TEST_WORKER_CRASH',clock_timestamp())`,
  [manualRun, traceId]);
  const review = await withTransaction({ pool, isolation: 'SERIALIZABLE' }, (client) => openReview(client, {
    subjectType: 'QUEST', subjectId: 'expired-quest-review', reason: 'old uncertain test', context,
  }));
  const result = await resolveSubjectReview({ reviewId: review.id, decision: 'RETRY',
    reason: 'operator clicked retry after expiry', isOwner: false, expectedVersion: review.state_version }, context, { pool });
  assert.equal(result.review.state, 'RESOLVED');
  assert.equal(result.applied.status, 'QUEST_EXPIRED');
  assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM quest_test_batches
    WHERE quest_id='expired-quest-review'`)).rows[0].count, 0);
  assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM quest_test_runs
    WHERE quest_id='expired-quest-review' AND state='TEST_QUEUED'`)).rows[0].count, 0);
});

test('maintenance derives a passed monitor batch after a crash between test-run and batch transitions', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const traceId = uuidv7(); const monitor = uuidv7(); const batch = uuidv7(); const run = uuidv7();
  const context = createContext({ traceId, actorType: 'SYSTEM', actorId: 'recovery', guildId: 'guild',
    idempotencyKey: 'reconcile-passed-batch' });
  await pool.query(`INSERT INTO monitor_accounts(id,account_id,capabilities,state) VALUES($1,$2,ARRAY['TEST'],'ACTIVE')`,
    [monitor, `recovery-monitor-${monitor.slice(0, 6)}`]);
  const questId = `recovery-${run.slice(0, 8)}`;
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,name,task_type,task_target,url,expires_at,
    executor_id,engine_version,executor_version,contract_version)
    VALUES($1,'SUPPORTED',$1,'WATCH_VIDEO',60,$2,clock_timestamp()+interval '1 day','video','1','1','1')`,
  [questId, `https://discord.com/quests/${questId}`]);
  await pool.query(`INSERT INTO quest_test_batches(id,quest_id,state,monitor_order,trace_id,requested_by)
    VALUES($1,$2,'RUNNING',ARRAY[$3]::uuid[],$4,'SYSTEM')`, [batch, questId, monitor, traceId]);
  await pool.query(`INSERT INTO quest_test_runs(id,quest_id,batch_id,target_monitor_id,monitor_id,state,
    engine_version,executor_version,contract_version,attempt_in_monitor,trace_id,completed_at)
    VALUES($1,$2,$3,$4,$4,'TEST_PASSED','1','1','1',1,$5,clock_timestamp())`,
  [run, questId, batch, monitor, traceId]);
  await withTransaction({ pool, isolation: 'SERIALIZABLE' }, (client) => reconcilePassedMonitorTestBatches(client, context));
  assert.equal((await pool.query('SELECT state FROM quest_test_batches WHERE id=$1', [batch])).rows[0].state, 'PASSED');
});

test('maintenance advances a failed monitor batch left incomplete by an older worker crash', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const traceId = uuidv7(); const monitor = uuidv7(); const batch = uuidv7(); const run = uuidv7();
  const questId = `failed-gap-${run.slice(0, 8)}`;
  const context = createContext({ traceId, actorType: 'SYSTEM', actorId: 'recovery', guildId: 'guild',
    idempotencyKey: 'reconcile-failed-batch' });
  await pool.query(`INSERT INTO monitor_accounts(id,account_id,capabilities,state)
    VALUES($1,$2,ARRAY['TEST'],'ACTIVE')`, [monitor, `failed-monitor-${monitor.slice(0, 6)}`]);
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,name,task_type,task_target,url,expires_at,
    executor_id,engine_version,executor_version,contract_version)
    VALUES($1,'SUPPORTED',$1,'WATCH_VIDEO',60,$2,clock_timestamp()+interval '1 day','video','1','1','1')`,
  [questId, `https://discord.com/quests/${questId}`]);
  await pool.query(`INSERT INTO quest_test_batches(id,quest_id,state,monitor_order,trace_id,requested_by)
    VALUES($1,$2,'RUNNING',ARRAY[$3]::uuid[],$4,'SYSTEM')`, [batch, questId, monitor, traceId]);
  await pool.query(`INSERT INTO quest_test_runs(id,quest_id,batch_id,target_monitor_id,monitor_id,state,
    engine_version,executor_version,contract_version,attempt_in_monitor,trace_id,error_class,completed_at)
    VALUES($1,$2,$3,$4,$4,'TEST_FAILED','1','1','1',1,$5,'TEST_WORKER_CRASH',clock_timestamp())`,
  [run, questId, batch, monitor, traceId]);
  const reconciled = await withTransaction({ pool, isolation: 'SERIALIZABLE' },
    (client) => reconcileFailedMonitorTestBatches(client, context));
  assert.equal(reconciled, 1);
  const attempts = (await pool.query(`SELECT state,attempt_in_monitor FROM quest_test_runs
    WHERE batch_id=$1 ORDER BY created_at`, [batch])).rows;
  assert.deepEqual(attempts, [
    { state: 'TEST_FAILED', attempt_in_monitor: 1 },
    { state: 'TEST_QUEUED', attempt_in_monitor: 2 },
  ]);
});

test('fatal Monitor authentication failure quarantines before the batch chooses its next token', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const traceId = uuidv7(); const first = uuidv7(); const second = uuidv7(); const batchId = uuidv7();
  const runId = uuidv7(); const workerId = uuidv7(); const questId = `fatal-auth-${runId.slice(0, 8)}`;
  const context = createContext({ traceId, actorType: 'SYSTEM', actorId: 'quest-test', guildId: 'guild',
    idempotencyKey: 'fatal-auth-switches-monitor' });
  await pool.query(`INSERT INTO monitor_accounts(id,account_id,capabilities,state,priority) VALUES
    ($1,'fatal-auth-a',ARRAY['TEST'],'ACTIVE',2),($2,'fatal-auth-b',ARRAY['TEST'],'ACTIVE',1)`, [first, second]);
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,name,task_type,task_target,url,expires_at,
    executor_id,engine_version,executor_version,contract_version)
    VALUES($1,'SUPPORTED',$1,'WATCH_VIDEO',60,$2,clock_timestamp()+interval '1 day','video','1','1','1')`,
  [questId, `https://discord.com/quests/${questId}`]);
  await pool.query(`INSERT INTO quest_test_batches(id,quest_id,state,monitor_order,trace_id,requested_by)
    VALUES($1,$2,'RUNNING',ARRAY[$3,$4]::uuid[],$5,'SYSTEM')`, [batchId, questId, first, second, traceId]);
  await pool.query(`INSERT INTO quest_test_runs(id,quest_id,batch_id,target_monitor_id,monitor_id,state,engine_version,
    executor_version,contract_version,attempt_in_monitor,trace_id,lease_owner,lease_expires_at,fencing_token)
    VALUES($1,$2,$3,$4,$4,'TESTING','1','1','1',1,$5,$6,clock_timestamp()+interval '2 minutes',1)`,
  [runId, questId, batchId, first, traceId, workerId]);
  const run = (await pool.query('SELECT * FROM quest_test_runs WHERE id=$1', [runId])).rows[0];
  await handleTestFailure(pool, run, { id: first, consecutive_failures: 0 },
    Object.assign(new Error('token rejected'), { fatalAuth: true, code: 'TOKEN_REJECTED' }), context);
  assert.equal((await pool.query('SELECT state FROM monitor_accounts WHERE id=$1', [first])).rows[0].state, 'QUARANTINED');
  const attempts = (await pool.query(`SELECT target_monitor_id,state,attempt_in_monitor FROM quest_test_runs
    WHERE batch_id=$1 ORDER BY created_at,id`, [batchId])).rows;
  assert.deepEqual(attempts, [
    { target_monitor_id: first, state: 'MANUAL_REVIEW', attempt_in_monitor: 1 },
    { target_monitor_id: second, state: 'TEST_QUEUED', attempt_in_monitor: 1 },
  ]);
});
