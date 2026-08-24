import '../src/config/load-local-environment.js';
import { loadEnvironment, usesApplicationBackup } from '../src/config/env.js';
import { getRuntimePool, closePools } from '../src/db/pools.js';
import { createEncryptedBackup } from '../src/adapters/s3/backup.js';
import { v7 as uuidv7 } from 'uuid';

const env = loadEnvironment();
if (!usesApplicationBackup(env)) {
  throw new Error('Aiven-managed backup is active; Questshop pg_dump/S3 backup is not available');
}
const pool = getRuntimePool(env);
const runId = uuidv7();
try {
  const schemaVersion = Number((await pool.query('SELECT max(version) AS value FROM schema_migrations')).rows[0].value);
  await pool.query(`INSERT INTO backup_runs(id,backup_type,state,git_sha,encryption_key_version,manifest)
    VALUES($1,'DAILY','STARTED',$2,$3,$4)`, [runId, env.GIT_SHA, env.BACKUP_ENCRYPTION_KEYS_JSON.current, { reason: 'manual' }]);
  const backup = await createEncryptedBackup({ env, schemaVersion, reason: 'manual', backupId: runId });
  await pool.query(`UPDATE backup_runs SET state='VERIFIED',object_key=$2,checksum=$3,size_bytes=$4,
    schema_version=$5,manifest=$6,completed_at=clock_timestamp() WHERE id=$1`,
  [runId, backup.objectKey, backup.checksum, backup.sizeBytes, schemaVersion, backup]);
  console.log(JSON.stringify({ ok: true, backup }));
} catch (error) {
  await pool.query(`UPDATE backup_runs SET state='FAILED',error_code=$2,completed_at=clock_timestamp() WHERE id=$1`,
    [runId, error.code ?? error.name]).catch(() => null);
  throw error;
} finally { await closePools(); }
