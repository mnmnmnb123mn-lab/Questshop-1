import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPool } from '../fixtures/postgres.js';
import { seedLeasedRunner } from '../fixtures/leased-runner.js';
import { processRunnerJob } from '../../src/domain/runner/service.js';
import { FencingLostError } from '../../src/shared/errors.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

test('controlled retry has a separate durable IN_FLIGHT checkpoint before its external send', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const fixture = await seedLeasedRunner(pool, { questId: 'retry-checkpoint-quest',
    userId: 'retry-checkpoint-user', accountId: 'retry-checkpoint-account', taskTarget: 10 });
  const initialQuest = { id: fixture.questId, eventName: 'WATCH_VIDEO', autoSupported: true,
    completed: false, completedAt: null, progress: 0, progressSecs: 0, secondsNeeded: 10,
    enrolled: true, enrolledAt: new Date(Date.now() - 60_000).toISOString(),
    url: `https://discord.com/quests/${fixture.questId}` };
  let mutationCalls = 0;
  let checkpointSnapshot = null;
  const api = {
    fetchCurrentUser: async () => ({ id: fixture.accountId }),
    fetchQuests: async () => [initialQuest],
    sendVideoProgress: async () => {
      mutationCalls += 1;
      if (mutationCalls === 1) return { ok: true };
      checkpointSnapshot = (await pool.query(`SELECT status,evidence FROM runner_mutations
        WHERE job_id=$1 ORDER BY sequence_number`, [fixture.jobId])).rows;
      throw new FencingLostError(`test:${fixture.jobId}`);
    },
  };
  await assert.rejects(processRunnerJob(fixture.job, { env: fixture.env,
    options: { pool, questApiFactory: () => api } }), (error) => error.code === 'FENCING_LOST');
  assert.equal(mutationCalls, 2);
  assert.equal(checkpointSnapshot.length, 2);
  assert.equal(checkpointSnapshot[0].status, 'FAILED');
  assert.equal(checkpointSnapshot[0].evidence.controlledRetryScheduled, true);
  assert.equal(checkpointSnapshot[1].status, 'IN_FLIGHT');
  assert.equal(checkpointSnapshot[1].evidence.controlledRetry, true);
  assert.equal(typeof checkpointSnapshot[1].evidence.parentMutationId, 'string');
});
