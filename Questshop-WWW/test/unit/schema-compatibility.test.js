import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMigrationChecksums, validateSchemaCompatibility } from '../../src/db/migrations.js';
import { MAX_COMPATIBLE_SCHEMA_VERSION, MIN_COMPATIBLE_SCHEMA_VERSION } from '../../src/config/versions.js';

function databaseAt(version) {
  return { query: async () => ({ rows: [{ version }] }) };
}

test('runtime accepts only the fully expanded schema required by this source revision', async () => {
  assert.equal(MIN_COMPATIBLE_SCHEMA_VERSION, MAX_COMPATIBLE_SCHEMA_VERSION);
  assert.equal(await validateSchemaCompatibility(databaseAt(MAX_COMPATIBLE_SCHEMA_VERSION)),
    MAX_COMPATIBLE_SCHEMA_VERSION);
  await assert.rejects(validateSchemaCompatibility(databaseAt(MIN_COMPATIBLE_SCHEMA_VERSION - 1)),
    /incompatible/);
  await assert.rejects(validateSchemaCompatibility(databaseAt(MAX_COMPATIBLE_SCHEMA_VERSION + 1)),
    /incompatible/);
});

test('runtime refuses a schema whose applied migration source differs from this image', async () => {
  const migrations = [
    { version: 1, name: '0001_foundation.sql', checksum: 'expected-one' },
    { version: 2, name: '0002_wallet.sql', checksum: 'expected-two' },
  ];
  const matchingDatabase = { query: async () => ({ rows: migrations.map(({ version, name, checksum }) => (
    { version, name, checksum }
  )) }) };
  assert.equal(await validateMigrationChecksums(matchingDatabase, { migrations }), 2);

  const changedDatabase = { query: async () => ({ rows: [
    { version: 1, name: '0001_foundation.sql', checksum: 'expected-one' },
    { version: 2, name: '0002_wallet.sql', checksum: 'wrong-bytes' },
  ] }) };
  await assert.rejects(validateMigrationChecksums(changedDatabase, { migrations }), (error) => (
    error.code === 'SCHEMA_MIGRATION_CHECKSUM_MISMATCH'
  ));
});
