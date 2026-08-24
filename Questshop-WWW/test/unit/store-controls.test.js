import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FEATURE_GATES, FEATURE_GATES } from '../../src/config/feature-gates.js';
import {
  DEFAULT_QUEST_PRICE_CENTS,
  questPriceCategoryForTaskType,
  taskTypesForQuestPriceCategory,
} from '../../src/domain/pricing/categories.js';
import { setQuestCategoryPrice } from '../../src/domain/admin/config-service.js';
import { createContext } from '../../src/shared/correlation.js';
import { ADMIN_CATEGORIES, adminCategoryOptions } from '../../src/discord/renderers/admin.js';

test('a new store starts normal internal gates open without an admin setup step', () => {
  assert.deepEqual(Object.keys(DEFAULT_FEATURE_GATES), FEATURE_GATES);
  assert.ok(Object.values(DEFAULT_FEATURE_GATES).every(Boolean));
});

test('customer-facing Quest prices have exactly two durable categories at 5 baht', () => {
  assert.equal(DEFAULT_QUEST_PRICE_CENTS, 500n);
  assert.deepEqual(taskTypesForQuestPriceCategory('GAME'), ['PLAY_ON_DESKTOP', 'PLAY_ON_DESKTOP_V2']);
  assert.deepEqual(taskTypesForQuestPriceCategory('VIDEO'), ['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE']);
  assert.equal(questPriceCategoryForTaskType('PLAY_ON_DESKTOP_V2'), 'GAME');
  assert.equal(questPriceCategoryForTaskType('WATCH_VIDEO_ON_MOBILE'), 'VIDEO');
});

test('admin navigation exposes only the nine simplified operational categories', () => {
  assert.deepEqual(ADMIN_CATEGORIES.map(([key]) => key), [
    'overview', 'pricing', 'promotions', 'orders', 'payments', 'wallet', 'monitors', 'receivers', 'dlq',
  ]);
});

test('ordinary Admin navigation omits Owner-only receiver and monitor controls', () => {
  assert.deepEqual(adminCategoryOptions(null, { isOwner: false }).map((option) => option.value), [
    'overview', 'pricing', 'promotions', 'orders', 'payments', 'wallet', 'dlq',
  ]);
  assert.ok(adminCategoryOptions(null, { isOwner: true }).some((option) => option.value === 'monitors'));
  assert.ok(adminCategoryOptions(null, { isOwner: true }).some((option) => option.value === 'receivers'));
});

test('category price changes require both current rule versions before a transaction starts', async () => {
  const context = createContext({ actorType: 'ADMIN', actorId: 'admin', guildId: 'guild', idempotencyKey: 'price-test' });
  await assert.rejects(
    setQuestCategoryPrice({ category: 'GAME', amountCents: 500n }, context),
    /current Quest category price version is required/,
  );
});
