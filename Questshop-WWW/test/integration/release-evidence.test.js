import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { updateFeatureGate } from '../../src/domain/admin/config-service.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

const release = Object.freeze({ prelaunch: true, gitSha: '9cf9a75', appVersion: '0.1.0', engineVersion: '1.0.0' });

test('pre-launch gate changes preserve append-only release evidence without requiring a Git SHA', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'OWNER', actorId: 'owner', guildId: 'guild',
    idempotencyKey: 'prelaunch-gate-evidence' });
  const before = (await pool.query("SELECT * FROM feature_gates WHERE gate='TOPUP_ACCEPTING'")).rows[0];
  const changed = await updateFeatureGate({ gate: before.gate, enabled: true,
    expectedVersion: before.version, reason: 'owner pre-launch payment test', release }, context, { pool });
  assert.equal(changed.enabled, true);
  const evidence = (await pool.query(`SELECT * FROM release_evidence WHERE evidence_type='PRELAUNCH_GATE'
    AND subject_id=$1`, [`TOPUP_ACCEPTING:v${changed.version}`])).rows[0];
  assert.equal(evidence.git_sha, release.gitSha);
  assert.equal(evidence.prelaunch, true);
  assert.equal(evidence.evidence.enabled, true);
  const orderGate = (await pool.query("SELECT * FROM feature_gates WHERE gate='ORDER_ACCEPTING'")).rows[0];
  const untracked = await updateFeatureGate({ gate: 'ORDER_ACCEPTING', enabled: true,
    expectedVersion: orderGate.version, reason: 'deployment revision not supplied',
    release: { ...release, gitSha: 'untracked' } }, context, { pool });
  assert.equal(untracked.enabled, true);
  assert.equal((await pool.query(`SELECT git_sha FROM release_evidence WHERE subject_id=$1`,
    [`ORDER_ACCEPTING:v${untracked.version}`])).rows[0].git_sha, 'untracked');
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM release_evidence')).rows[0].count), 2);
});
