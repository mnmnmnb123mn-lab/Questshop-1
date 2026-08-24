import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { adjustBalance } from '../../src/domain/wallet/service.js';
import { buildQuote, confirmOrder, createSession, selectAll } from '../../src/domain/checkout/service.js';
import { questContractHash } from '../../src/quest-engine/schema/contract.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function checkoutEnvironment() {
  const key = Buffer.alloc(32, 4).toString('base64');
  return {
    PRELAUNCH: true,
    RUNNER_CONCURRENCY: 3,
    DATA_ENCRYPTION_KEYS_JSON: { current: 1, keys: { 1: key } },
    DISCORD_CLIENT_VERSION: '1.0.0',
    DISCORD_CHROME_VERSION: '1.0.0',
    DISCORD_ELECTRON_VERSION: '1.0.0',
    DISCORD_BUILD_NUMBER: 1, DISCORD_NATIVE_BUILD_NUMBER: 1, DISCORD_LOCALE: 'en-US',
  };
}

function checkoutApi() {
  const now = new Date();
  const quest = { id: 'race-quest', name: 'Race Quest', eventName: 'WATCH_VIDEO',
    secondsNeeded: 60, progressSecs: 0, progress: 0, completed: false, completedAt: null,
    enrolled: true, enrolledAt: now.toISOString(), autoSupported: true, executorId: 'video',
    startsAt: now.toISOString(), expiresAt: new Date(now.getTime() + ONE_DAY_MS).toISOString(),
    url: 'https://discord.com/quests/race-quest', artworkUrl: null, orbs: 10,
    applicationId: 'app-race', progressKey: 'video', coreComplete: true, compatibilityIssues: [] };
  const contract = questContractHash(quest, { engineVersion: '1.0.0', executorVersion: '1.0.0',
    contractVersion: '1.0.0' });
  return {
    fetchCurrentUser: async () => ({ id: 'race-account', username: 'Race Account', avatar: null }),
    fetchQuests: async () => [{ ...quest, contractHash: contract.hash, contractComplete: contract.complete }],
  };
}

function context(actorId, idempotencyKey) {
  return createContext({ actorType: 'CUSTOMER', actorId, guildId: '10000000000000002', idempotencyKey });
}

test('simultaneous confirmation of one checkout creates one order and one reservation', { timeout: 60_000 }, async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const trace = uuidv7();
  const user = 'checkout-race-user';
  const env = checkoutEnvironment();
  const options = { pool, questApiFactory: checkoutApi };
  await pool.query(`INSERT INTO price_rules(id,rule_type,amount_cents,config_version,actor_id,trace_id)
    VALUES($1,'DEFAULT',500,1,'owner',$2)`, [uuidv7(), trace]);
  await adjustBalance({ discordUserId: user, amountCents: 1_000n, reason: 'race seed' },
    context(user, 'race-seed'), { pool });
  const created = await createSession({ discordUserId: user, guildId: '10000000000000002',
    channelId: '10000000000000003', messageId: null, token: 'race-token', env },
  context(user, 'race-session'), options);
  await selectAll({ sessionId: created.session.id, actorId: user, guildId: '10000000000000002' },
    context(user, 'race-select'), options);
  await buildQuote({ sessionId: created.session.id, actorId: user, guildId: '10000000000000002' },
    context(user, 'race-quote'), options);
  const input = { sessionId: created.session.id, actorId: user, guildId: '10000000000000002', env };
  const results = await Promise.allSettled([
    confirmOrder(input, context(user, 'race-confirm-a'), options),
    confirmOrder(input, context(user, 'race-confirm-b'), options),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
  assert.equal(results[0].value.orderId, results[1].value.orderId);
  assert.equal(results.filter((result) => result.value.idempotent === true).length, 1);
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM orders')).rows[0].count), 1);
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM wallet_reservations')).rows[0].count), 1);
  const wallet = (await pool.query('SELECT available_cents,reserved_cents FROM wallets WHERE discord_user_id=$1', [user])).rows[0];
  assert.equal(BigInt(wallet.available_cents), 500n);
  assert.equal(BigInt(wallet.reserved_cents), 500n);
});
