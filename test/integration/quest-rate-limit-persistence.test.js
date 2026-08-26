import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPool } from '../fixtures/postgres.js';
import { prunePersistentRateLimitBlocks } from '../../src/quest-engine/rate-limits/coordinator.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

test('persistent Quest API cooldown cleanup is bounded and preserves active blocks', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  await pool.query(`INSERT INTO quest_api_rate_limit_blocks(scope,block_key,blocked_until) VALUES
    ('ROUTE','expired-one',clock_timestamp()-interval '2 hours'),
    ('ROUTE','expired-two',clock_timestamp()-interval '2 hours'),
    ('ROUTE','active',clock_timestamp()+interval '2 hours')`);
  assert.equal(await prunePersistentRateLimitBlocks({ pool, limit: 1 }), 1);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM quest_api_rate_limit_blocks
    WHERE blocked_until<clock_timestamp()`)).rows[0].count), 1);
  assert.equal(await prunePersistentRateLimitBlocks({ pool, limit: 500 }), 1);
  assert.equal(Number((await pool.query(`SELECT count(*)::integer AS count FROM quest_api_rate_limit_blocks
    WHERE block_key='active'`)).rows[0].count), 1);
});
