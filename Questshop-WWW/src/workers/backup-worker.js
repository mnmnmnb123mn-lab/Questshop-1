import { v7 as uuidv7 } from 'uuid';
import { createEncryptedBackup } from '../adapters/s3/backup.js';
import { DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { createS3Client } from '../adapters/s3/client.js';
import { usesApplicationBackup } from '../config/env.js';
import { createContext } from '../shared/correlation.js';
import { reconcileIncident } from '../domain/incidents/service.js';

function backupContext(env, action) {
  return createContext({ actorType: 'SYSTEM', actorId: 'backup-worker', guildId: env.DISCORD_GUILD_ID,
    idempotencyKey: `backup:${action}` });
}

export async function pruneExpiredBackups({ env, pool }) {
  const expired = (await pool.query(`SELECT id,object_key,manifest FROM backup_runs
    WHERE state='VERIFIED' AND completed_at<clock_timestamp()-interval '30 days'
      AND object_key IS NOT NULL ORDER BY completed_at LIMIT 100`)).rows;
  if (!expired.length) return 0;
  const s3 = createS3Client(env);
  const objects = expired.flatMap((row) => [
    { Key: row.object_key, ...(row.manifest?.objectVersion ? { VersionId: row.manifest.objectVersion } : {}) },
    { Key: row.manifest?.manifestKey ?? `${row.object_key}.json` },
  ]);
  const result = await s3.send(new DeleteObjectsCommand({ Bucket: env.S3_BUCKET,
    Delete: { Objects: objects, Quiet: false } }));
  if (result.Errors?.length) throw Object.assign(new Error('backup retention object deletion failed'), {
    code: 'BACKUP_RETENTION_DELETE_FAILED', details: result.Errors.map((error) => error.Code),
  });
  await pool.query(`UPDATE backup_runs SET state='EXPIRED',expired_at=clock_timestamp()
    WHERE id=ANY($1::uuid[]) AND state='VERIFIED'`, [expired.map((row) => row.id)]);
  return expired.length;
}

export async function runScheduledBackup({ env, pool }) {
  if (!usesApplicationBackup(env)) return false;
  try { await pruneExpiredBackups({ env, pool }); }
  catch (error) {
    await reconcileIncident({ code: 'BACKUP_RETENTION_FAILED', scope: 'S3', active: true,
      severity: 'ERROR', evidence: { errorCode: error.code ?? error.name } }, backupContext(env, 'retention'), { pool });
    throw error;
  }
  const due = (await pool.query(`SELECT
    (clock_timestamp() AT TIME ZONE 'Asia/Bangkok')::time >= time '03:00' AS after_three,
    NOT EXISTS(SELECT 1 FROM backup_runs WHERE backup_type='DAILY' AND state='VERIFIED'
      AND (completed_at AT TIME ZONE 'Asia/Bangkok')::date=(clock_timestamp() AT TIME ZONE 'Asia/Bangkok')::date) AS missing,
    (SELECT max(version) FROM schema_migrations)::integer AS schema_version`)).rows[0];
  if (!due.after_three || !due.missing) return false;
  const id = uuidv7();
  await pool.query(`INSERT INTO backup_runs(id,backup_type,state,git_sha,encryption_key_version,manifest)
    VALUES($1,'DAILY','STARTED',$2,$3,$4)`, [id, env.GIT_SHA,
    env.BACKUP_ENCRYPTION_KEYS_JSON.current, { reason: 'daily' }]);
  try {
    const backup = await createEncryptedBackup({ env, schemaVersion: due.schema_version, reason: 'daily', backupId: id });
    await pool.query(`UPDATE backup_runs SET state='VERIFIED',object_key=$2,checksum=$3,size_bytes=$4,
      schema_version=$5,manifest=$6,completed_at=clock_timestamp() WHERE id=$1`,
    [id, backup.objectKey, backup.checksum, backup.sizeBytes, due.schema_version, backup]);
  } catch (error) {
    await pool.query(`UPDATE backup_runs SET state='FAILED',error_code=$2,completed_at=clock_timestamp()
      WHERE id=$1`, [id, error.code ?? error.name]);
    await reconcileIncident({ code: 'BACKUP_FAILED', scope: 'DAILY', active: true,
      severity: 'CRITICAL', evidence: { errorCode: error.code ?? error.name } }, backupContext(env, 'daily'), { pool });
    throw error;
  }
  return true;
}
