import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { withTransaction } from '../../src/db/transaction.js';
import { openReview } from '../../src/domain/reviews/service.js';
import { queueMaintenanceNotifications } from '../../src/workers/maintenance-worker.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

test('a 24-hour reminder records evidence without changing review authority', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'SYSTEM', actorId: 'maintenance-test', guildId: 'guild',
    idempotencyKey: 'manual-review-reminder' });
  const review = await withTransaction({ pool, isolation: 'SERIALIZABLE' }, (client) => openReview(client, {
    subjectType: 'QUEST', subjectId: `reminder-${context.traceId}`, reason: 'test reminder', ownerOnly: false, context,
  }));
  await pool.query(`UPDATE manual_reviews SET created_at=clock_timestamp()-interval '25 hours',
    remind_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [review.id]);
  const beforeRow = (await pool.query('SELECT owner_only,state_version FROM manual_reviews WHERE id=$1', [review.id])).rows[0];
  await withTransaction({ pool, isolation: 'SERIALIZABLE' },
    (client) => queueMaintenanceNotifications(client, context));
  const afterRow = (await pool.query('SELECT owner_only,state_version FROM manual_reviews WHERE id=$1', [review.id])).rows[0];
  assert.deepEqual(afterRow, beforeRow);
  assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM review_evidence
    WHERE review_id=$1 AND evidence_type='REMINDER_SENT'`, [review.id])).rows[0].count, 1);
});
