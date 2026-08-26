import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { ingestDiscovery } from '../../src/domain/catalog/service.js';
import {
  acquireCustomerMonitorSearchCheck,
  completeCustomerMonitorSearchCheck,
  recordCustomerDiscoveryCase,
  retryCustomerDiscoveryCase,
} from '../../src/domain/catalog/customer-discovery-case-service.js';
import { publishCustomerDiscoveredQuest } from '../../src/domain/catalog/customer-discovery-service.js';
import { questContractHash } from '../../src/quest-engine/schema/contract.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

const DAY_MS = 24 * 60 * 60 * 1000;

function context(key, actorType = 'ADMIN') {
  return createContext({ traceId: uuidv7(), actorType, actorId: actorType === 'SYSTEM' ? 'worker' : 'admin',
    guildId: 'guild', idempotencyKey: key });
}

function normalized(id) {
  const quest = {
    id, name: `Customer discovery ${id}`, eventName: 'WATCH_VIDEO', secondsNeeded: 60,
    startsAt: new Date().toISOString(), expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
    url: `https://discord.com/quests/${id}`, artworkUrl: null, orbs: 10,
    applicationId: `app-${id}`, progressKey: 'video', executorId: 'video',
    autoSupported: true, coreComplete: true, compatibilityIssues: [],
  };
  const contract = questContractHash(quest, {
    engineVersion: '1.0.0', executorVersion: '1.0.0', contractVersion: '1.0.0',
  });
  return { ...quest, contractHash: contract.hash, contractComplete: contract.complete };
}

async function insertDiscovery(questId, traceId = uuidv7()) {
  const id = uuidv7();
  return (await pool.query(`INSERT INTO customer_quest_discoveries(
      id,checkout_session_id,quest_id,metadata_revision,discord_user_id,account_id,
      account_username,account_avatar_url,trace_id
    ) VALUES($1,NULL,$2,1,'123456789012345678','account','Customer account',NULL,$3) RETURNING *`,
  [id, questId, traceId])).rows[0];
}

async function addMonitor(accountId, priority) {
  const id = uuidv7();
  await pool.query(`INSERT INTO monitor_accounts(id,account_id,capabilities,state,priority)
    VALUES($1,$2,ARRAY['TEST'],'ACTIVE',$3)`, [id, accountId, priority]);
  await pool.query(`INSERT INTO monitor_credentials(monitor_id,key_version,nonce,ciphertext,auth_tag)
    VALUES($1,1,$2,$3,$4)`, [id, Buffer.alloc(12), Buffer.alloc(32), Buffer.alloc(16)]);
  return id;
}

test('a customer Case announcement is informational and never opens public sale', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const ctx = context('customer-case-announce');
  await ingestDiscovery({ normalized: normalized('customer-private'), source: 'CUSTOMER_CHECKOUT' }, ctx, { pool });
  const discovery = await insertDiscovery('customer-private', ctx.traceId);
  const created = await pool.query('SELECT * FROM customer_quest_discovery_cases WHERE quest_id=$1', ['customer-private']);
  assert.equal(created.rowCount, 0);
  const client = await pool.connect();
  let caseResult;
  try {
    await client.query('BEGIN');
    caseResult = await recordCustomerDiscoveryCase(client, discovery, ctx);
    await client.query('COMMIT');
  } finally { client.release(); }
  assert.ok(caseResult.caseRow.id);
  const announced = await publishCustomerDiscoveredQuest({ discoveryId: discovery.id }, ctx, { pool });
  assert.equal(announced.idempotent, false);
  assert.equal((await pool.query("SELECT sale_state,public_test_gate_override FROM quests WHERE quest_id='customer-private'"))
    .rows[0].sale_state, 'CLOSED');
  assert.equal((await pool.query("SELECT public_test_gate_override FROM quests WHERE quest_id='customer-private'"))
    .rows[0].public_test_gate_override, false);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM message_projections
    WHERE projection_type='QUEST_NEW' AND aggregate_id='customer-private'`)).rows[0].count), 1);
  assert.equal((await publishCustomerDiscoveredQuest({ discoveryId: discovery.id }, ctx, { pool })).idempotent, true);
});

test('one customer Case searches all Test Monitors and creates a Case-only batch from visible accounts', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const ctx = context('customer-case-search', 'SYSTEM');
  await pool.query("UPDATE monitor_accounts SET state='DISABLED'");
  const hidden = await addMonitor('case-hidden', 10);
  const visible = await addMonitor('case-visible', 5);
  await ingestDiscovery({ normalized: normalized('customer-search'), source: 'CUSTOMER_CHECKOUT' }, ctx, { pool });
  const discovery = await insertDiscovery('customer-search', ctx.traceId);
  const client = await pool.connect();
  let created;
  try {
    await client.query('BEGIN');
    created = await recordCustomerDiscoveryCase(client, discovery, ctx);
    await client.query('COMMIT');
  } finally { client.release(); }
  assert.equal(created.reused, false);
  const duplicate = await retryCustomerDiscoveryCase({ caseId: created.caseRow.id }, ctx, { pool });
  assert.equal(duplicate.reused, true);
  const first = await acquireCustomerMonitorSearchCheck({ holder: uuidv7() }, { pool });
  const second = await acquireCustomerMonitorSearchCheck({ holder: uuidv7() }, { pool });
  assert.deepEqual(new Set([first.monitor_id, second.monitor_id]), new Set([hidden, visible]));
  await completeCustomerMonitorSearchCheck({ check: first,
    state: first.monitor_id === visible ? 'VISIBLE' : 'NOT_VISIBLE' }, ctx, { pool });
  await completeCustomerMonitorSearchCheck({ check: second,
    state: second.monitor_id === visible ? 'VISIBLE' : 'NOT_VISIBLE' }, ctx, { pool });
  const row = (await pool.query(`SELECT * FROM customer_quest_discovery_cases WHERE id=$1`, [created.caseRow.id])).rows[0];
  assert.equal(row.verification_state, 'TESTING');
  const batch = (await pool.query(`SELECT * FROM quest_test_batches WHERE customer_discovery_case_id=$1`, [row.id])).rows[0];
  assert.deepEqual(batch.monitor_order, [visible]);
  assert.equal((await pool.query(`SELECT target_monitor_id FROM quest_test_runs WHERE batch_id=$1`, [batch.id])).rows[0].target_monitor_id, visible);
  assert.ok(Number((await pool.query(`SELECT count(*)::integer AS count FROM state_transitions
    WHERE aggregate_type IN ('CUSTOMER_QUEST_DISCOVERY_CASE','CUSTOMER_MONITOR_SEARCH_BATCH','CUSTOMER_MONITOR_SEARCH_CHECK')
      AND trace_id=$1`, [ctx.traceId])).rows[0].count) >= 6);
});

test('a completed Case batch is never reused for a later customer retry', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const ctx = context('customer-case-retry-terminal', 'SYSTEM');
  await pool.query("UPDATE monitor_accounts SET state='DISABLED'");
  const monitor = await addMonitor('case-retry-monitor', 1);
  await ingestDiscovery({ normalized: normalized('customer-retry'), source: 'CUSTOMER_CHECKOUT' }, ctx, { pool });
  const discovery = await insertDiscovery('customer-retry', ctx.traceId);
  const client = await pool.connect();
  let created;
  try {
    await client.query('BEGIN');
    created = await recordCustomerDiscoveryCase(client, discovery, ctx);
    await client.query('COMMIT');
  } finally { client.release(); }
  let check = await acquireCustomerMonitorSearchCheck({ holder: uuidv7() }, { pool });
  await completeCustomerMonitorSearchCheck({ check, state: 'VISIBLE' }, ctx, { pool });
  const firstBatch = (await pool.query(`SELECT * FROM quest_test_batches WHERE customer_discovery_case_id=$1`, [created.caseRow.id])).rows[0];
  await pool.query("UPDATE quest_test_batches SET state='FAILED',completed_at=clock_timestamp() WHERE id=$1", [firstBatch.id]);
  await pool.query("UPDATE customer_quest_discovery_cases SET verification_state='TEST_FAILED' WHERE id=$1", [created.caseRow.id]);
  const retry = await retryCustomerDiscoveryCase({ caseId: created.caseRow.id }, ctx, { pool });
  assert.equal(retry.reused, false);
  check = await acquireCustomerMonitorSearchCheck({ holder: uuidv7() }, { pool });
  assert.equal(check.monitor_id, monitor);
  await completeCustomerMonitorSearchCheck({ check, state: 'VISIBLE' }, ctx, { pool });
  const batches = (await pool.query(`SELECT id FROM quest_test_batches WHERE customer_discovery_case_id=$1 ORDER BY created_at`,
    [created.caseRow.id])).rows;
  assert.equal(batches.length, 2);
  assert.notEqual(batches[0].id, batches[1].id);
});

test('a transient Monitor-search failure records retry evidence before the final incomplete result', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const ctx = context('customer-case-transient-retry', 'SYSTEM');
  await pool.query("UPDATE monitor_accounts SET state='DISABLED'");
  await addMonitor('case-transient-monitor', 1);
  await ingestDiscovery({ normalized: normalized('customer-transient'), source: 'CUSTOMER_CHECKOUT' }, ctx, { pool });
  const discovery = await insertDiscovery('customer-transient', ctx.traceId);
  const client = await pool.connect();
  let created;
  try {
    await client.query('BEGIN');
    created = await recordCustomerDiscoveryCase(client, discovery, ctx);
    await client.query('COMMIT');
  } finally { client.release(); }
  const first = await acquireCustomerMonitorSearchCheck({ holder: uuidv7() }, { pool });
  await completeCustomerMonitorSearchCheck({ check: first, state: 'PENDING',
    evidence: { result: 'RETRY_WAIT', retryable: true }, errorClass: 'RATE_LIMIT' }, ctx, { pool });
  const retry = await acquireCustomerMonitorSearchCheck({ holder: uuidv7() }, { pool });
  assert.equal(retry.id, first.id);
  assert.equal(Number(retry.attempt_count), 2);
  await completeCustomerMonitorSearchCheck({ check: retry, state: 'FAILED',
    evidence: { result: 'FAILED', retryable: true }, errorClass: 'RATE_LIMIT' }, ctx, { pool });
  const row = (await pool.query('SELECT verification_state,last_result FROM customer_quest_discovery_cases WHERE id=$1',
    [created.caseRow.id])).rows[0];
  assert.equal(row.verification_state, 'CHECK_INCOMPLETE');
  assert.equal(row.last_result.failed, 1);
});
