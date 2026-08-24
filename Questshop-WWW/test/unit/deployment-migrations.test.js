import test from 'node:test';
import assert from 'node:assert/strict';
import { runDeploymentMigrations } from '../../src/db/deployment-migrations.js';

function databaseUrl(role) {
  const url = new URL(['postgresql', ':', '/', '/db.example.invalid'].join(''));
  url.username = role;
  url.hostname = 'db.example.invalid';
  url.pathname = '/questshop_test';
  url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

function database(schemaVersion = 21) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      queries.push(sql);
      if (sql.includes("to_regclass('public.admin_audit_logs')")) return { rows: [{ value: 'admin_audit_logs' }] };
      if (sql.includes('to_regclass')) return { rows: [{ value: 'schema_migrations' }] };
      if (sql.includes('COALESCE(max(version)')) return { rows: [{ value: schemaVersion }] };
      if (sql.includes('INSERT INTO backup_runs')) return { rows: [] };
      if (sql.includes('INSERT INTO admin_audit_logs')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const env = {
  NODE_ENV: 'production', BACKUP_MODE: 'LOCAL_S3', BACKUP_ENABLED: true, GIT_SHA: 'a'.repeat(40),
  DATABASE_POOL_URL: databaseUrl('runtime'),
};

test('Aiven-managed deployment records its provider policy and migrates without pg_dump', async () => {
  const pool = database();
  const order = [];
  const result = await runDeploymentMigrations({ ...env, BACKUP_MODE: 'AIVEN_MANAGED', BACKUP_ENABLED: false }, {
    pool, listMigrations: async () => [{ version: 22 }],
    validateBackupTools: async () => { order.push('tools'); },
    createEncryptedBackup: async () => { order.push('backup'); },
    runMigrations: async () => { order.push('migrate'); return { current: 22, applied: 1 }; },
    validateOrInitializeKeyringSentinels: async () => { order.push('sentinels'); },
  });
  assert.deepEqual(order, ['migrate', 'sentinels']);
  assert.equal(result.preMigrationBackup, 'AIVEN_MANAGED_NOT_APP_VERIFIED');
  assert.ok(pool.queries.some((sql) => sql.includes('INSERT INTO admin_audit_logs')));
  assert.equal(pool.queries.some((sql) => sql.includes('INSERT INTO backup_runs')), false);
});

test('deployment verifies and records a backup before applying a pending production migration', async () => {
  const pool = database();
  const order = [];
  const result = await runDeploymentMigrations(env, {
    pool, listMigrations: async () => [{ version: 22 }],
    validateBackupTools: async () => { order.push('tools'); },
    createEncryptedBackup: async () => {
      order.push('backup');
      return { id: 'backup', objectKey: 'object', checksum: 'sum', sizeBytes: 1,
        schemaVersion: 21, encryptionKeyVersion: 1 };
    },
    runMigrations: async () => { order.push('migrate'); return { current: 22, applied: 1 }; },
    validateOrInitializeKeyringSentinels: async () => { order.push('sentinels'); },
  });
  assert.deepEqual(order, ['tools', 'backup', 'migrate', 'sentinels']);
  assert.equal(result.preMigrationBackup, 'VERIFIED');
  assert.ok(pool.queries.some((sql) => sql.includes('INSERT INTO backup_runs')));
});
