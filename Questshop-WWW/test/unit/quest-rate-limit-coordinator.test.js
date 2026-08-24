import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DiscordRateLimitCoordinator,
  PersistentDiscordRateLimitCoordinator,
  getPersistentDiscordRateLimitCoordinator,
} from '../../src/quest-engine/rate-limits/coordinator.js';

test('rate-limit coordinator isolates a Quest route and account without exposing a token', async () => {
  const coordinator = new DiscordRateLimitCoordinator({ concurrency: 1 });
  await coordinator.blockRoute('/quests/one/heartbeat', 1_000);
  await coordinator.blockAccount('token-one', 1_000);
  const status = coordinator.status();
  assert.equal(status.routeBlocks, 1);
  assert.equal(status.accountBlocks, 1);
  assert.equal(JSON.stringify(status).includes('token-one'), false);
});

test('rate-limit coordinator removes expired local cooldown entries and shares one persistent coordinator per pool', async () => {
  const coordinator = new DiscordRateLimitCoordinator();
  await coordinator.blockRoute('/quests/one/heartbeat', -1);
  await coordinator.blockAccount('token-one', -1);
  assert.deepEqual(coordinator.status(), {
    queued: 0, accounts: 0, globalBlockedUntil: 0, routeBlocks: 0, accountBlocks: 0,
  });
  const pool = { query: async () => ({ rows: [{ wait_ms: 0 }] }) };
  assert.equal(getPersistentDiscordRateLimitCoordinator(pool), getPersistentDiscordRateLimitCoordinator(pool));
});

test('persistent coordinator writes only opaque scope keys and consults PostgreSQL before dispatch', async () => {
  const queries = [];
  const pool = { query: async (sql, values = []) => {
    queries.push({ sql, values });
    if (sql.includes('SELECT EXTRACT')) return { rows: [{ wait_ms: 0 }] };
    return { rows: [] };
  } };
  const coordinator = new PersistentDiscordRateLimitCoordinator({ pool });
  await coordinator.blockRoute('/quests/one/heartbeat', 500);
  await coordinator.blockAccount('token-one', 500);
  const value = await coordinator.schedule({ token: 'token-one', path: '/quests/two/heartbeat',
    execute: async () => 'ok' });
  assert.equal(value, 'ok');
  assert.equal(queries.some((query) => query.sql.includes('INSERT INTO quest_api_rate_limit_blocks')), true);
  assert.equal(JSON.stringify(queries).includes('token-one'), false);
});
