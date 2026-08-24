import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectSourceSha, verifyConfiguredSourceSha } from '../../src/config/source-version.js';

const SHA = 'a'.repeat(40);

test('source revision verification compares a checked-out Git SHA without requiring Git metadata', () => {
  assert.equal(inspectSourceSha({ execute: () => `${SHA}\n` }), SHA);
  assert.equal(inspectSourceSha({ execute: () => { throw new Error('no git'); } }), null);
  assert.deepEqual(verifyConfiguredSourceSha({ GIT_SHA: SHA }, { execute: () => `${SHA}\n` }),
    { sourceSha: SHA, verified: true });
  assert.deepEqual(verifyConfiguredSourceSha({ GIT_SHA: SHA }, { execute: () => { throw new Error('no git'); } }),
    { sourceSha: null, verified: false });
  assert.throws(() => verifyConfiguredSourceSha({ GIT_SHA: SHA }, { execute: () => 'b'.repeat(40) }), /does not match/);
});
