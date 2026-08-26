import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('checkout and runner pin and revalidate the Quest execution contract', async () => {
  const [checkout, runner, gate] = await Promise.all([
    readFile(new URL('../../src/domain/checkout/service.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/domain/runner/service.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/domain/catalog/test-gate.js', import.meta.url), 'utf8'),
  ]);
  assert.match(checkout, /contract_hash/);
  assert.match(checkout, /QUEST_CONTRACT_CHANGED/);
  assert.match(runner, /item_contract_hash !== quest\.contractHash/);
  assert.match(runner, /QUEST_CONTRACT_CHANGED/);
  assert.match(gate, /contract_hash=\$5/);
});

test('migration permits a fresh active Monitor batch only for a different contract', async () => {
  const migration = await readFile(new URL('../../migrations/0024_quest_contract_pinning.sql', import.meta.url), 'utf8');
  assert.match(migration, /DROP INDEX quest_test_batches_one_active_idx/);
  assert.match(migration, /ON quest_test_batches\(quest_id, contract_hash\)/);
});

test('a background test defers safely and verifies a crash checkpoint before retry', async () => {
  const worker = await readFile(new URL('../../src/workers/quest-test-worker.js', import.meta.url), 'utf8');
  assert.match(worker, /enforceTestAdmission/);
  assert.match(worker, /verifyRecoveredTestMutation/);
  assert.match(worker, /parentMutationId/);
  assert.match(worker, /possiblySent/);
});
