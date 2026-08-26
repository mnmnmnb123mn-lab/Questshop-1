import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { ingestDiscovery } from '../../src/domain/catalog/service.js';
import { questContractHash } from '../../src/quest-engine/schema/contract.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function normalized(id, secondsNeeded, overrides = {}) {
  const quest = { id, name: `Retest ${id}`, eventName: 'WATCH_VIDEO', secondsNeeded,
    startsAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ONE_DAY_MS).toISOString(),
    url: `https://discord.com/quests/${id}`, artworkUrl: null, thumbnailUrl: null,
    orbs: 10, orbReward: { mode: 'SINGLE', minOrbs: 10, maxOrbs: 10, values: [10] },
    applicationId: `app-${id}`, progressKey: 'video', executorId: 'video', autoSupported: true,
    coreComplete: true, compatibilityIssues: [], ...overrides };
  const contract = questContractHash(quest, { engineVersion: '1.0.0', executorVersion: '1.0.0',
    contractVersion: '1.0.0' });
  return { ...quest, contractHash: contract.hash, contractComplete: contract.complete && quest.coreComplete };
}

test('a changed execution contract creates exactly one distinct Monitor retest batch', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const traceId = uuidv7();
  const context = createContext({ traceId, actorType: 'SYSTEM', actorId: 'scanner', guildId: 'guild',
    idempotencyKey: 'catalog-contract-retest' });
  const monitorId = uuidv7();
  await pool.query(`INSERT INTO monitor_accounts(id,account_id,capabilities,state)
    VALUES($1,'retest-monitor',ARRAY['SCAN','TEST'],'ACTIVE')`, [monitorId]);
  const first = normalized('contract-retest', 60);
  const second = normalized('contract-retest', 120);
  await ingestDiscovery({ normalized: first, source: 'MONITOR' }, context, { pool });
  await ingestDiscovery({ normalized: second, source: 'MONITOR' }, { ...context,
    idempotencyKey: 'catalog-contract-retest-changed' }, { pool });
  const batches = (await pool.query(`SELECT contract_hash,state FROM quest_test_batches
    WHERE quest_id='contract-retest' ORDER BY created_at,id`)).rows;
  assert.equal(batches.length, 2);
  assert.notEqual(batches[0].contract_hash, batches[1].contract_hash);
  assert.ok(batches.every((batch) => batch.state === 'RUNNING'));
  const queued = (await pool.query(`SELECT count(*)::integer AS count FROM quest_test_runs
    WHERE quest_id='contract-retest' AND state='TEST_QUEUED'`)).rows[0].count;
  assert.equal(Number(queued), 2);
});

test('partial discovery inherits presentation metadata but a later complete payload can remove it', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const questId = 'presentation-revision-authority';
  const baseContext = createContext({ traceId: uuidv7(), actorType: 'SYSTEM', actorId: 'catalog-test', guildId: 'guild',
    idempotencyKey: 'presentation-revision-complete' });
  const first = normalized(questId, 60, {
    artworkUrl: 'https://cdn.discordapp.com/assets/quests/presentation-revision-authority/hero.jpg',
    thumbnailUrl: 'https://cdn.discordapp.com/assets/quests/presentation-revision-authority/tile.png',
    orbs: 750,
    orbReward: { mode: 'SINGLE', minOrbs: 750, maxOrbs: 750, values: [750] },
  });
  await ingestDiscovery({ normalized: first, source: 'ADMIN' }, baseContext, { pool });

  const partial = normalized(questId, 0, {
    eventName: 'UNKNOWN_SCHEMA', secondsNeeded: 0, startsAt: null, expiresAt: null,
    artworkUrl: null, thumbnailUrl: null, orbs: null, orbReward: null,
    executorId: 'unsupported', autoSupported: false, coreComplete: false, contractComplete: false,
  });
  await ingestDiscovery({ normalized: partial, source: 'ADMIN' }, { ...baseContext, traceId: uuidv7(),
    idempotencyKey: 'presentation-revision-partial' }, { pool });
  const afterPartial = (await pool.query(`SELECT m.normalized FROM quests q
    JOIN quest_metadata_revisions m ON m.quest_id=q.quest_id AND m.revision=q.current_metadata_revision
    WHERE q.quest_id=$1`, [questId])).rows[0].normalized;
  assert.equal(afterPartial.thumbnailUrl, first.thumbnailUrl);
  assert.deepEqual(afterPartial.orbReward, first.orbReward);

  const completeRemoval = normalized(questId, 60, {
    artworkUrl: null, thumbnailUrl: null, orbs: null, orbReward: null,
  });
  await ingestDiscovery({ normalized: completeRemoval, source: 'ADMIN' }, { ...baseContext, traceId: uuidv7(),
    idempotencyKey: 'presentation-revision-removed' }, { pool });
  const afterComplete = (await pool.query(`SELECT q.artwork_url,q.orbs,m.normalized
    FROM quests q JOIN quest_metadata_revisions m
      ON m.quest_id=q.quest_id AND m.revision=q.current_metadata_revision
    WHERE q.quest_id=$1`, [questId])).rows[0];
  assert.equal(afterComplete.artwork_url, null);
  assert.equal(afterComplete.orbs, null);
  assert.equal(afterComplete.normalized.thumbnailUrl, null);
  assert.equal(afterComplete.normalized.orbReward, null);
});
