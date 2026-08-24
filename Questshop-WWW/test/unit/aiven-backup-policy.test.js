import test from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledBackup } from '../../src/workers/backup-worker.js';
import { usesApplicationBackup } from '../../src/config/env.js';

test('Aiven-managed mode never starts Questshop pg_dump/S3 backup work', async () => {
  const pool = { query: async () => { throw new Error('database backup query must not run'); } };
  const env = { BACKUP_MODE: 'AIVEN_MANAGED', BACKUP_ENABLED: false };
  assert.equal(usesApplicationBackup(env), false);
  assert.equal(await runScheduledBackup({ env, pool }), false);
});

test('legacy enabled local backup configuration remains an explicit compatibility mode', () => {
  assert.equal(usesApplicationBackup({ BACKUP_ENABLED: true }), true);
  assert.equal(usesApplicationBackup({ BACKUP_MODE: 'LOCAL_S3', BACKUP_ENABLED: true }), true);
});
