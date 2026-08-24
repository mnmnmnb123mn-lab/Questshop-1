import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { configuredQuestPriceRange, resolvePrice } from '../../src/domain/pricing/resolver.js';
import { setQuestCategoryPrice } from '../../src/domain/admin/config-service.js';
import { createContext } from '../../src/shared/correlation.js';
import { APPLICATION_EVENTS, applicationEvents } from '../../src/shared/application-events.js';
import { resolvePromotionBonus } from '../../src/domain/promotions/resolver.js';
import { bangkokDayBounds } from '../../src/db/postgres-time.js';
import { ANALYSIS_TRANSITIONS, SALE_TRANSITIONS, TEST_TRANSITIONS } from '../../src/domain/catalog/states.js';
import { ORDER_ITEM_TRANSITIONS } from '../../src/domain/orders/states.js';
import { TOPUP_TRANSITIONS } from '../../src/domain/payments/states.js';
import { RUNNER_JOB_TRANSITIONS } from '../../src/domain/runner/states.js';
import { REVIEW_TRANSITIONS } from '../../src/domain/reviews/states.js';
import { createTestPool } from '../fixtures/postgres.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

function graphStates(graph) { return [...new Set([...Object.keys(graph), ...Object.values(graph).flat()])].sort(); }
async function databaseStates(table, column) {
  const rows = (await pool.query(`SELECT pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c WHERE c.conrelid=$1::regclass AND c.contype='c'
      AND pg_get_constraintdef(c.oid) LIKE $2`, [table, `%${column}%`])).rows;
  const values = rows.flatMap((row) => [...row.definition.matchAll(/'([A-Z][A-Z0-9_]*)'::text/g)]
    .map((match) => match[1]));
  return [...new Set(values)].sort();
}

test('PostgreSQL enum checks remain synchronized with domain state graphs', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  assert.deepEqual(await databaseStates('quests', 'analysis_state'), graphStates(ANALYSIS_TRANSITIONS));
  assert.deepEqual(await databaseStates('quests', 'sale_state'), graphStates(SALE_TRANSITIONS));
  assert.deepEqual(await databaseStates('quest_test_runs', 'state'), graphStates(TEST_TRANSITIONS));
  assert.deepEqual(await databaseStates('topups', 'status'), graphStates(TOPUP_TRANSITIONS));
  assert.deepEqual(await databaseStates('order_items', 'state'), graphStates(ORDER_ITEM_TRANSITIONS));
  assert.deepEqual(await databaseStates('runner_jobs', 'state'), graphStates(RUNNER_JOB_TRANSITIONS));
  assert.deepEqual(await databaseStates('manual_reviews', 'state'), graphStates(REVIEW_TRANSITIONS));
});

test('new store resolves all four supported task types from two 5-baht categories', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  for (const taskType of ['PLAY_ON_DESKTOP', 'PLAY_ON_DESKTOP_V2', 'WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE']) {
    const price = await resolvePrice(pool, { taskType });
    assert.equal(price.rule_type, 'TYPE');
    assert.equal(BigInt(price.amount_cents), 500n);
  }
  assert.deepEqual(await configuredQuestPriceRange(pool), { minCents: 500n, maxCents: 500n });
});

test('changing GAME price is atomic, versioned, emits after commit, never changes VIDEO, and updates the storefront range source', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const before = (await pool.query(`SELECT task_type,state_version FROM price_rules
    WHERE enabled=true AND rule_type='TYPE' AND task_type IN ('PLAY_ON_DESKTOP','PLAY_ON_DESKTOP_V2')`)).rows;
  const context = createContext({ actorType: 'ADMIN', actorId: 'price-admin', guildId: 'guild',
    idempotencyKey: `category-price:${uuidv7()}` });
  const emitted = new Promise((resolve, reject) => {
    applicationEvents.once(APPLICATION_EVENTS.QUEST_CATEGORY_PRICE_CHANGED, async (event) => {
      try {
        const committed = await resolvePrice(pool, { taskType: 'PLAY_ON_DESKTOP' });
        resolve({ event, committed });
      } catch (error) { reject(error); }
    });
  });
  await setQuestCategoryPrice({ category: 'GAME', amountCents: 750n,
    expectedVersions: Object.fromEntries(before.map((row) => [row.task_type, String(row.state_version)])) }, context, { pool });
  const notification = await emitted;
  assert.equal(notification.event.category, 'GAME');
  assert.equal(notification.event.amountCents, 750n);
  assert.equal(notification.event.traceId, context.traceId);
  assert.equal(BigInt(notification.committed.amount_cents), 750n);
  for (const taskType of ['PLAY_ON_DESKTOP', 'PLAY_ON_DESKTOP_V2']) {
    assert.equal(BigInt((await resolvePrice(pool, { taskType })).amount_cents), 750n);
  }
  for (const taskType of ['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE']) {
    assert.equal(BigInt((await resolvePrice(pool, { taskType })).amount_cents), 500n);
  }
  assert.deepEqual(await configuredQuestPriceRange(pool), { minCents: 500n, maxCents: 750n });
  const active = await pool.query(`SELECT task_type,count(*)::integer AS count FROM price_rules
    WHERE enabled=true AND rule_type='TYPE' GROUP BY task_type`);
  assert.ok(active.rows.every((row) => row.count === 1));
});

test('legacy default, Quest and temporary price rows never override the two category prices', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  await pool.query("INSERT INTO quests(quest_id,analysis_state) VALUES('legacy-quest','DETECTED')");
  await pool.query(`INSERT INTO price_rules(id,rule_type,amount_cents,priority,enabled,config_version,actor_id,trace_id)
    VALUES($1,'DEFAULT',1,999,true,1,'test',$2)`, [uuidv7(), uuidv7()]);
  await pool.query(`INSERT INTO price_rules(id,rule_type,quest_id,amount_cents,priority,enabled,config_version,actor_id,trace_id)
    VALUES($1,'QUEST','legacy-quest',1,999,true,1,'test',$2)`, [uuidv7(), uuidv7()]);
  await pool.query(`INSERT INTO price_rules(id,rule_type,task_type,amount_cents,priority,enabled,config_version,actor_id,trace_id)
    VALUES($1,'TEMPORARY','WATCH_VIDEO',1,999,true,1,'test',$2)`, [uuidv7(), uuidv7()]);
  assert.equal(BigInt((await resolvePrice(pool, { taskType: 'WATCH_VIDEO' })).amount_cents), 500n);
});

test('promotion selects highest tier, rounds half-up, caps daily bonus and enforces user limit', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const promotionId = uuidv7(); const trace = uuidv7(); const user = '10000000000000123';
  await pool.query(`INSERT INTO promotions(id,version,name,state,starts_at,ends_at,manual_controlled,max_uses_per_user,
    max_bonus_per_day_cents,actor_id,trace_id) VALUES($1,1,'internal-version','ACTIVE',NULL,NULL,true,2,5000,'test',$2)`, [promotionId, trace]);
  for (const [minimum, points] of [[10_000, 1000], [30_000, 1500], [60_000, 2000]]) {
    await pool.query(`INSERT INTO promotion_tiers(id,promotion_id,minimum_amount_cents,basis_points)
      VALUES($1,$2,$3,$4)`, [uuidv7(), promotionId, minimum, points]);
  }
  const first = await resolvePromotionBonus(pool, { promotionId, discordUserId: user,
    principalCents: 30_004n, bangkokDay: '2026-08-02' });
  assert.equal(first.bonusCents, 4_501n);
  assert.equal(first.eligible, true);
  await pool.query(`INSERT INTO promotion_usages(id,promotion_id,discord_user_id,topup_id,bangkok_day,
    principal_cents,bonus_cents) VALUES($1,$2,$3,$4,'2026-08-02',30004,4501)`,
  [uuidv7(), promotionId, user, uuidv7()]);
  const capped = await resolvePromotionBonus(pool, { promotionId, discordUserId: user,
    principalCents: 30_004n, bangkokDay: '2026-08-02' });
  assert.equal(capped.bonusCents, 499n);
  await pool.query(`INSERT INTO promotion_usages(id,promotion_id,discord_user_id,topup_id,bangkok_day,
    principal_cents,bonus_cents) VALUES($1,$2,$3,$4,'2026-08-01',10000,1000)`,
  [uuidv7(), promotionId, user, uuidv7()]);
  const limited = await resolvePromotionBonus(pool, { promotionId, discordUserId: user,
    principalCents: 60_000n, bangkokDay: '2026-08-02' });
  assert.equal(limited.eligible, false);
  assert.equal(limited.reason, 'USER_LIMIT');
});

test('Bangkok promotion day is computed in PostgreSQL and does not drift through UTC midnight', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const bounds = await bangkokDayBounds(pool, '2026-08-01T17:30:00.000Z');
  assert.equal(bounds.bangkok_day, '2026-08-02');
  assert.equal(new Date(bounds.starts_at).toISOString(), '2026-08-01T17:00:00.000Z');
});
