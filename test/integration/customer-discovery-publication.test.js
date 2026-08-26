import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { ingestDiscovery } from '../../src/domain/catalog/service.js';
import {
  loadCustomerQuestDiscovery,
  publishCustomerDiscoveredQuest,
  requestCustomerDiscoveryTest,
} from '../../src/domain/catalog/customer-discovery-service.js';
import { questContractHash } from '../../src/quest-engine/schema/contract.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

const DAY_MS = 24 * 60 * 60 * 1000;

function context(key) {
  return createContext({ traceId: uuidv7(), actorType: 'ADMIN', actorId: 'admin', guildId: 'guild', idempotencyKey: key });
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

async function insertCustomerDiscovery(questId, traceId = uuidv7()) {
  const id = uuidv7();
  await pool.query(`INSERT INTO customer_quest_discoveries(
      id,checkout_session_id,quest_id,metadata_revision,discord_user_id,account_id,
      account_username,trace_id
    ) VALUES($1,NULL,$2,1,'customer','account','Customer account',$3)`, [id, questId, traceId]);
  await pool.query(`INSERT INTO message_projections(id,projection_type,aggregate_id,surface_key,nonce)
    VALUES($1,'CUSTOMER_QUEST_DISCOVERY',$2,'LOG_QUEST_OPERATIONS','customer-discovery')`, [uuidv7(), id]);
  return id;
}

test('customer discovery stays private until Admin explicitly publishes it', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const quest = normalized('customer-private');
  await ingestDiscovery({ normalized: quest, source: 'CUSTOMER_CHECKOUT' }, context('ingest'), { pool });
  assert.equal((await pool.query("SELECT sale_state FROM quests WHERE quest_id='customer-private'")).rows[0].sale_state, 'CLOSED');
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM message_projections
    WHERE projection_type='QUEST_NEW' AND aggregate_id='customer-private'`)).rows[0].count), 0);

  const discoveryId = await insertCustomerDiscovery(quest.id);
  const bound = await loadCustomerQuestDiscovery(pool, discoveryId, { messageId: null });
  assert.equal(bound.state, 'PENDING');
  const first = await publishCustomerDiscoveredQuest({ discoveryId, runnerConcurrency: 3 }, context('publish'), { pool });
  assert.equal(first.idempotent, false);
  assert.equal(first.quest.sale_state, 'OPEN');
  assert.equal(first.discovery.state, 'PUBLISHED');
  const duplicate = await publishCustomerDiscoveredQuest({ discoveryId, runnerConcurrency: 3 }, context('publish-repeat'), { pool });
  assert.equal(duplicate.idempotent, true);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM message_projections
    WHERE projection_type='QUEST_NEW' AND aggregate_id='customer-private'`)).rows[0].count), 1);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM admin_audit_logs
    WHERE action='CUSTOMER_DISCOVERY_FORCE_PUBLISH' AND target_id='customer-private'`)).rows[0].count), 1);
});

test('Admin can request a Monitor test instead of publishing a customer discovery', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const monitorId = uuidv7();
  await pool.query(`INSERT INTO monitor_accounts(id,account_id,capabilities,state,priority)
    VALUES($1,'customer-discovery-monitor',ARRAY['TEST'],'ACTIVE',1)`, [monitorId]);
  const quest = normalized('customer-test-first');
  await ingestDiscovery({ normalized: quest, source: 'CUSTOMER_CHECKOUT' }, context('ingest-test'), { pool });
  const discoveryId = await insertCustomerDiscovery(quest.id);
  const result = await requestCustomerDiscoveryTest({ discoveryId }, context('request-test'), { pool });
  assert.equal(result.idempotent, false);
  assert.equal(result.discovery.state, 'TEST_REQUESTED');
  assert.equal(result.batch.state, 'RUNNING');
  assert.equal((await pool.query("SELECT sale_state FROM quests WHERE quest_id='customer-test-first'")).rows[0].sale_state, 'CLOSED');
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM message_projections
    WHERE projection_type='QUEST_NEW' AND aggregate_id='customer-test-first'`)).rows[0].count), 0);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM quest_test_runs
    WHERE quest_id='customer-test-first' AND state='TEST_QUEUED'`)).rows[0].count), 1);
  const duplicate = await requestCustomerDiscoveryTest({ discoveryId }, context('request-test-repeat'), { pool });
  assert.equal(duplicate.idempotent, true);
});

test('customer discovery evidence survives checkout-session deletion', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const quest = normalized('customer-retention');
  await ingestDiscovery({ normalized: quest, source: 'CUSTOMER_CHECKOUT' }, context('ingest-retention'), { pool });
  const sessionId = uuidv7();
  const discoveryId = uuidv7();
  await pool.query(`INSERT INTO interaction_sessions(
      id,actor_id,guild_id,channel_id,operation,state,config_version,payload,expires_at,trace_id
    ) VALUES($1,'customer','guild','channel','CHECKOUT','TERMINAL',1,'{}',clock_timestamp()-interval '1 day',$2)`,
  [sessionId, uuidv7()]);
  await pool.query(`INSERT INTO customer_quest_discoveries(
      id,checkout_session_id,quest_id,metadata_revision,discord_user_id,account_id,trace_id
    ) VALUES($1,$2,$3,1,'customer','account',$4)`, [discoveryId, sessionId, quest.id, uuidv7()]);
  await pool.query('DELETE FROM interaction_sessions WHERE id=$1', [sessionId]);
  const row = (await pool.query('SELECT checkout_session_id FROM customer_quest_discoveries WHERE id=$1', [discoveryId])).rows[0];
  assert.equal(row.checkout_session_id, null);
});
