import test from 'node:test';
import assert from 'node:assert/strict';
import { APPLICATION_EVENTS, applicationEvents } from '../../src/shared/application-events.js';
import { installQuestPriceSurfaceRefresh } from '../../src/workers/worker-manager.js';

test('committed Quest price changes schedule an immediate background surface reconciliation', async () => {
  const calls = [];
  const warnings = [];
  const controller = new AbortController();
  const config = { version: 7, values: {} };
  const client = { questshop: { config } };
  const listener = installQuestPriceSurfaceRefresh({
    client,
    pool: { name: 'pool' },
    env: { DISCORD_GUILD_ID: 'guild' },
    signal: controller.signal,
    logger: { warn: (...args) => warnings.push(args) },
    reconcile: async (input, context) => {
      calls.push({ input, context });
      return [{ surfaceKey: 'QUEST_AUTO', refreshed: true }];
    },
  });
  try {
    applicationEvents.emit(APPLICATION_EVENTS.QUEST_CATEGORY_PRICE_CHANGED, {
      category: 'VIDEO', amountCents: 700n, traceId: 'price-trace',
    });
    await listener.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input.client, client);
    assert.equal(calls[0].input.config, config);
    assert.equal(calls[0].context.traceId, 'price-trace');
    assert.equal(calls[0].context.actorType, 'SYSTEM');
    assert.equal(warnings.length, 0);

    listener.dispose();
    applicationEvents.emit(APPLICATION_EVENTS.QUEST_CATEGORY_PRICE_CHANGED, {
      category: 'GAME', amountCents: 500n, traceId: 'after-dispose',
    });
    await listener.flush();
    assert.equal(calls.length, 1);
  } finally {
    listener.dispose();
  }
});
