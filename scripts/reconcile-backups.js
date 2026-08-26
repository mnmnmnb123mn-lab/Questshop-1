import '../src/config/load-local-environment.js';
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { loadEnvironment, usesApplicationBackup } from '../src/config/env.js';
import { createS3Client } from '../src/adapters/s3/client.js';
import { closeDirectPool, getDirectPool } from '../src/db/pools.js';

const env = loadEnvironment();
if (!usesApplicationBackup(env)) {
  throw new Error('Aiven-managed backup is active; Questshop S3 backup reconciliation is unavailable');
}

function validManifest(value) {
  return value && typeof value === 'object'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
    && typeof value.objectKey === 'string' && value.objectKey.endsWith('.qsbk')
    && /^[a-f0-9]{64}$/i.test(value.checksum)
    && Number.isInteger(value.schemaVersion) && Number.isInteger(value.encryptionKeyVersion)
    && value.reason === 'pre-migration';
}

const MANIFEST_MAX_BYTES = 64 * 1024;

async function readManifest(s3, key) {
  const response = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key,
    // Request one byte past the limit so an object at the boundary remains
    // valid while an oversized object is rejected before full buffering.
    Range: `bytes=0-${MANIFEST_MAX_BYTES}` }));
  if (Number(response.ContentLength) > MANIFEST_MAX_BYTES) {
    throw new Error(`Backup manifest is too large: ${key}`);
  }
  const text = await response.Body.transformToString();
  if (Buffer.byteLength(text) > MANIFEST_MAX_BYTES) throw new Error(`Backup manifest is too large: ${key}`);
  const manifest = JSON.parse(text);
  if (!validManifest(manifest) || `${manifest.objectKey}.json` !== key) {
    throw new Error(`Backup manifest is invalid: ${key}`);
  }
  return manifest;
}

const s3 = createS3Client(env);
const pool = getDirectPool(env);
let continuationToken;
let reconciled = 0;
try {
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: env.S3_BUCKET, Prefix: 'questshop/', ContinuationToken: continuationToken }));
    for (const object of page.Contents ?? []) {
      if (!object.Key?.endsWith('.qsbk.json')) continue;
      const manifest = await readManifest(s3, object.Key);
      const head = await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: manifest.objectKey }));
      if (Number(head.ContentLength) !== Number(manifest.sizeBytes)) {
        throw new Error(`Backup object size mismatch: ${manifest.objectKey}`);
      }
      const result = await pool.query(`INSERT INTO backup_runs(
        id,backup_type,state,object_key,checksum,size_bytes,schema_version,git_sha,
        encryption_key_version,manifest,completed_at
      ) VALUES($1,'PRE_MIGRATION','VERIFIED',$2,$3,$4,$5,$6,$7,$8,clock_timestamp())
      ON CONFLICT (id) DO NOTHING`, [
        manifest.id, manifest.objectKey, manifest.checksum, manifest.sizeBytes,
        manifest.schemaVersion, manifest.gitSha, manifest.encryptionKeyVersion, manifest,
      ]);
      reconciled += result.rowCount;
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : null;
  } while (continuationToken);
  console.log(JSON.stringify({ ok: true, reconciled }));
} finally {
  await closeDirectPool();
}
