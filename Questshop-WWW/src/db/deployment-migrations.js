import { createEncryptedBackup, validateBackupTools } from '../adapters/s3/backup.js';
import { validateOrInitializeKeyringSentinels } from '../bootstrap/keyring-sentinels.js';
import { usesApplicationBackup } from '../config/env.js';
import { closeDirectPool, getDirectPool } from './pools.js';
import { listMigrations, runMigrations } from './migrations.js';
import { v7 as uuidv7 } from 'uuid';

async function preparePreMigrationBackup({ database, env, applicationBackupEnabled, list, backup }) {
  const migrationTable = (await database.query(
    "SELECT to_regclass('public.schema_migrations') AS value",
  )).rows[0].value;
  if (!migrationTable) {
    return { artifact: null, status: 'FIRST_INSTALL_NOT_APPLICABLE' };
  }

  const schemaVersion = Number((await database.query(
    'SELECT COALESCE(max(version),0) AS value FROM schema_migrations',
  )).rows[0].value);
  const migrations = await list();
  const latestVersion = migrations.length ? Math.max(...migrations.map((migration) => migration.version)) : 0;
  if (schemaVersion >= latestVersion) {
    return { artifact: null, status: applicationBackupEnabled ? 'NO_PENDING_MIGRATION' : 'AIVEN_MANAGED' };
  }
  if (!applicationBackupEnabled) {
    // Aiven owns the database backup lifecycle. Do not claim that Questshop
    // verified a provider backup or restore drill: this durable record only
    // states the Owner-selected deployment policy and exact release SHA.
    return { artifact: null, status: 'AIVEN_MANAGED_NOT_APP_VERIFIED', recordProviderPolicy: true };
  }

  const artifact = await backup({ env, schemaVersion, reason: 'pre-migration' });
  return { artifact, status: 'VERIFIED' };
}

async function recordPreMigrationBackup(database, env, backup) {
  if (!backup) return;
  await database.query(`INSERT INTO backup_runs(id,backup_type,state,object_key,checksum,size_bytes,schema_version,
    git_sha,encryption_key_version,manifest,completed_at) VALUES($1,'PRE_MIGRATION','VERIFIED',$2,$3,$4,$5,$6,$7,$8,clock_timestamp())`,
  [backup.id, backup.objectKey, backup.checksum, backup.sizeBytes, backup.schemaVersion, env.GIT_SHA,
    backup.encryptionKeyVersion, backup]);
}

async function canRecordBackup(database) {
  return Boolean((await database.query(
    "SELECT to_regclass('public.backup_runs') AS value",
  )).rows[0].value);
}

async function recordAivenManagedBackupPolicy(database, env) {
  const table = (await database.query(
    "SELECT to_regclass('public.admin_audit_logs') AS value",
  )).rows[0].value;
  if (!table) return false;
  await database.query(`INSERT INTO admin_audit_logs(
    id,action,target_type,target_id,actor_id,before_state,after_state,reason,trace_id,correlation_code
  ) VALUES($1,'DEPLOYMENT_BACKUP_POLICY','DATABASE','AIVEN_MANAGED','OWNER',NULL,$2,$3,$4,$5)`, [
    uuidv7(),
    { provider: 'AIVEN', verification: 'NOT_APP_VERIFIED', gitSha: env.GIT_SHA },
    'Owner selected Aiven-managed backup; Questshop local pg_dump/S3 backup was not run',
    uuidv7(), env.GIT_SHA.slice(0, 10).toUpperCase(),
  ]);
  return true;
}

export async function runDeploymentMigrations(env, options = {}) {
  const applicationBackupEnabled = usesApplicationBackup(env);
  const database = options.pool ?? getDirectPool(env);
  const close = options.pool ? null : (options.closeDirectPool ?? closeDirectPool);
  const list = options.listMigrations ?? listMigrations;
  const migrate = options.runMigrations ?? runMigrations;
  const backup = options.createEncryptedBackup ?? createEncryptedBackup;
  const validateTools = options.validateBackupTools ?? validateBackupTools;
  const validateSentinels = options.validateOrInitializeKeyringSentinels
    ?? validateOrInitializeKeyringSentinels;
  try {
    if (env.NODE_ENV === 'production' && applicationBackupEnabled) await validateTools(env);
    const preMigrationBackup = await preparePreMigrationBackup({
      database, env, applicationBackupEnabled, list, backup,
    });
    // Old schema versions may not have backup_runs yet. When it already
    // exists, persist the verified artifact before migration; otherwise the
    // manifest remains the evidence until the expanded schema can record it.
    const recordBeforeMigration = preMigrationBackup.artifact && await canRecordBackup(database);
    if (recordBeforeMigration) await recordPreMigrationBackup(database, env, preMigrationBackup.artifact);
    if (preMigrationBackup.recordProviderPolicy) await recordAivenManagedBackupPolicy(database, env);
    const migration = await migrate({ pool: database, gitSha: env.GIT_SHA,
      runtimeRole: decodeURIComponent(new URL(env.DATABASE_POOL_URL).username) });
    await validateSentinels(database, env);
    if (preMigrationBackup.artifact && !recordBeforeMigration) {
      await recordPreMigrationBackup(database, env, preMigrationBackup.artifact);
    }
    return { migration, preMigrationBackup: preMigrationBackup.status };
  } finally {
    await close?.();
  }
}
