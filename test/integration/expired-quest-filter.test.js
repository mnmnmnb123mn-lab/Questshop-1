import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { withTransaction } from '../../src/db/transaction.js';
import { createContext } from '../../src/shared/correlation.js';
import { ingestDiscovery } from '../../src/domain/catalog/service.js';
import { advanceMonitorTestBatch } from '../../src/domain/catalog/test-gate.js';
import { enqueueProjection } from '../../src/domain/outbox/service.js';
import { questContractHash } from '../../src/quest-engine/schema/contract.js';
import { processOutbox } from '../../src/workers/outbox-worker.js';
import { reconcileSellableQuests } from '../../src/workers/maintenance-worker.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

function expiredQuest(id) {
  const quest = {
    id,
    name: `Expired ${id}`,
    eventName: 'WATCH_VIDEO',
    secondsNeeded: 60,
    startsAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    url: `https://discord.com/quests/${id}`,
    artworkUrl: null,
    orbs: 10,
    applicationId: `app-${id}`,
    progressKey: 'video',
    executorId: 'video',
    autoSupported: true,
    coreComplete: true,
    compatibilityIssues: [],
  };
  const contract = questContractHash(quest, {
    engineVersion: '1.0.0', executorVersion: '1.0.0', contractVersion: '1.0.0',
  });
  return { ...quest, contractHash: contract.hash, contractComplete: contract.complete };
}

test('Monitor discovery keeps expired Quest as history but never queues a Monitor test or QUEST_NEW', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'SYSTEM', actorId: 'scanner', guildId: 'guild',
    idempotencyKey: 'expired-monitor-discovery' });
  const result = await ingestDiscovery({ normalized: expiredQuest('expired-monitor'), source: 'MONITOR' },
    context, { pool });

  assert.equal(result.quest.sale_state, 'EXPIRED');
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM quest_test_batches
    WHERE quest_id='expired-monitor'`)).rows[0].count), 0);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM message_projections
    WHERE projection_type='QUEST_NEW' AND aggregate_id='expired-monitor'`)).rows[0].count), 0);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM message_projections
    WHERE projection_type='QUEST_OPERATION' AND aggregate_id='expired-monitor'`)).rows[0].count), 1);
});

test('expired customer-side discovery is never emitted as QUEST_NEW either', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'CUSTOMER', actorId: 'customer', guildId: 'guild',
    idempotencyKey: 'expired-customer-discovery' });
  const result = await ingestDiscovery({ normalized: expiredQuest('expired-customer'), source: 'CUSTOMER_CHECKOUT' },
    context, { pool });

  assert.equal(result.quest.sale_state, 'EXPIRED');
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM message_projections
    WHERE projection_type='QUEST_NEW' AND aggregate_id='expired-customer'`)).rows[0].count), 0);
});

test('outbox enqueue boundary refuses a first-time QUEST_NEW for an already expired Quest', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'SYSTEM', actorId: 'maintenance', guildId: 'guild',
    idempotencyKey: 'expired-outbox-guard' });
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,sale_state,name,task_type,task_target,url,expires_at)
    VALUES('expired-outbox','SUPPORTED','CLOSED','Expired outbox','WATCH_VIDEO',60,
      'https://discord.com/quests/expired-outbox',clock_timestamp()-interval '1 minute')`);

  const projection = await enqueueProjection(pool, {
    projectionType: 'QUEST_NEW', aggregateType: 'QUEST', aggregateId: 'expired-outbox',
    aggregateVersion: 1, surfaceKey: 'QUEST_NEW', context,
  });
  assert.equal(projection, null);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM message_projections
    WHERE projection_type='QUEST_NEW' AND aggregate_id='expired-outbox'`)).rows[0].count), 0);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM outbox_events
    WHERE aggregate_type='QUEST' AND aggregate_id='expired-outbox'`)).rows[0].count), 0);
});

test('maintenance expires historical Quest without creating a first-time QUEST_NEW projection', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'SYSTEM', actorId: 'maintenance', guildId: 'guild',
    idempotencyKey: 'expired-maintenance-no-announcement' });
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,sale_state,name,task_type,task_target,url,expires_at,
    public_test_gate_override)
    VALUES('expired-maintenance','SUPPORTED','OPEN','Expired maintenance','WATCH_VIDEO',60,
      'https://discord.com/quests/expired-maintenance',clock_timestamp()-interval '1 minute',true)`);

  await reconcileSellableQuests(pool, context, 2);
  assert.deepEqual((await pool.query(`SELECT analysis_state,sale_state FROM quests
    WHERE quest_id='expired-maintenance'`)).rows[0], { analysis_state: 'EXPIRED', sale_state: 'EXPIRED' });
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM message_projections
    WHERE projection_type='QUEST_NEW' AND aggregate_id='expired-maintenance'`)).rows[0].count), 0);
});

test('queued QUEST_NEW that expires during delivery backoff is suppressed before Discord send', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const questId = `delivery-expiry-${uuidv7().slice(0, 8)}`;
  const context = createContext({ actorType: 'SYSTEM', actorId: 'scanner', guildId: 'guild',
    idempotencyKey: `delivery-expiry:${questId}` });
  await pool.query(`INSERT INTO surfaces(surface_key,guild_id,channel_id,message_id,state)
    VALUES('QUEST_NEW','guild','quest-new-channel','anchor','ACTIVE') ON CONFLICT(surface_key) DO UPDATE SET
      guild_id=EXCLUDED.guild_id,channel_id=EXCLUDED.channel_id,message_id=EXCLUDED.message_id,state='ACTIVE'`);
  await pool.query("UPDATE feature_gates SET enabled=true WHERE gate='QUEST_ANNOUNCEMENT_ENABLED'");
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,sale_state,name,task_type,task_target,url,expires_at)
    VALUES($1,'SUPPORTED','OPEN',$1,'WATCH_VIDEO',60,$2,clock_timestamp()+interval '1 hour')`,
  [questId, `https://discord.com/quests/${questId}`]);
  const projection = await enqueueProjection(pool, { projectionType: 'QUEST_NEW', aggregateType: 'QUEST',
    aggregateId: questId, aggregateVersion: 1, surfaceKey: 'QUEST_NEW', context });
  assert.ok(projection);
  await pool.query(`UPDATE quests SET sale_state='EXPIRED',expires_at=clock_timestamp()-interval '1 second'
    WHERE quest_id=$1`, [questId]);

  let channelFetches = 0;
  const client = { channels: { fetch: async () => {
    channelFetches += 1;
    throw new Error('expired Quest must be suppressed before Discord channel fetch');
  } } };
  assert.equal(await processOutbox({ holder: uuidv7(), client, pool, env: {} }), true);
  assert.equal(channelFetches, 0);
  const event = (await pool.query(`SELECT * FROM outbox_events WHERE projection_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [projection.id])).rows[0];
  assert.equal(event.state, 'DELIVERED');
  assert.equal((await pool.query('SELECT message_id FROM message_projections WHERE id=$1', [projection.id]))
    .rows[0].message_id, null);
  assert.equal((await pool.query('SELECT announcement_state FROM quests WHERE quest_id=$1', [questId]))
    .rows[0].announcement_state, 'NOT_ANNOUNCED');
  assert.equal((await pool.query(`SELECT reason_code FROM state_transitions
    WHERE aggregate_type='OUTBOX_EVENT' AND aggregate_id=$1 AND to_state='DELIVERED'`, [event.id])).rows[0].reason_code,
  'QUEST_ANNOUNCEMENT_EXPIRED');
});

test('an active Monitor test batch stops without switching tokens when the Quest expires', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const traceId = uuidv7(); const monitorOne = uuidv7(); const monitorTwo = uuidv7();
  const batchId = uuidv7(); const runId = uuidv7(); const questId = `batch-expiry-${runId.slice(0, 8)}`;
  const context = createContext({ traceId, actorType: 'SYSTEM', actorId: 'maintenance', guildId: 'guild',
    idempotencyKey: `batch-expiry:${questId}` });
  await pool.query(`INSERT INTO monitor_accounts(id,account_id,capabilities,state,priority) VALUES
    ($1,$3,ARRAY['TEST'],'ACTIVE',2),($2,$4,ARRAY['TEST'],'ACTIVE',1)`,
  [monitorOne, monitorTwo, `expiry-one-${monitorOne.slice(0, 6)}`, `expiry-two-${monitorTwo.slice(0, 6)}`]);
  await pool.query(`INSERT INTO quests(quest_id,analysis_state,sale_state,name,task_type,task_target,url,expires_at,
    executor_id,engine_version,executor_version,contract_version)
    VALUES($1,'SUPPORTED','CLOSED',$1,'WATCH_VIDEO',60,$2,clock_timestamp()-interval '1 second',
      'video','1','1','1')`, [questId, `https://discord.com/quests/${questId}`]);
  await pool.query(`INSERT INTO quest_test_batches(id,quest_id,state,monitor_order,trace_id,requested_by)
    VALUES($1,$2,'RUNNING',ARRAY[$3,$4]::uuid[],$5,'SYSTEM')`, [batchId, questId, monitorOne, monitorTwo, traceId]);
  await pool.query(`INSERT INTO quest_test_runs(id,quest_id,batch_id,target_monitor_id,state,engine_version,
    executor_version,contract_version,attempt_in_monitor,deadline_at,trace_id,error_class,completed_at)
    VALUES($1,$2,$3,$4,'TEST_FAILED','1','1','1',1,clock_timestamp()-interval '1 second',$5,
      'TEST_QUEST_EXPIRED',clock_timestamp())`, [runId, questId, batchId, monitorOne, traceId]);
  const run = (await pool.query('SELECT * FROM quest_test_runs WHERE id=$1', [runId])).rows[0];
  const quest = (await pool.query('SELECT * FROM quests WHERE quest_id=$1', [questId])).rows[0];
  const advanced = await withTransaction({ pool, isolation: 'SERIALIZABLE' },
    (client) => advanceMonitorTestBatch(client, { run, quest,
      error: { code: 'TEST_QUEST_EXPIRED' }, context }));
  assert.equal(advanced.expired, true);
  assert.equal(advanced.queued, null);
  assert.equal((await pool.query('SELECT state FROM quest_test_batches WHERE id=$1', [batchId])).rows[0].state,
    'FAILED');
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM quest_test_runs
    WHERE batch_id=$1`, [batchId])).rows[0].count), 1);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM quest_test_failure_alerts
    WHERE quest_id=$1`, [questId])).rows[0].count), 0);
});
