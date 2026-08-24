import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { Upload } from '@aws-sdk/lib-storage';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { v7 as uuidv7 } from 'uuid';
import { createS3Client } from './client.js';
import { withPostgresRootCertificate } from './postgres-tls.js';
import {
  APP_VERSION,
  ENGINE_VERSION,
  EXECUTOR_VERSION,
  QUEST_CONTRACT_VERSION,
  RUNNER_STATE_SCHEMA_VERSION,
} from '../../config/versions.js';

const MAGIC = Buffer.from('QSBK1');
const execFileAsync = promisify(execFile);

function currentKey(keyring) {
  return { version: keyring.current, key: Buffer.from(keyring.keys[String(keyring.current)], 'base64') };
}
function sourceDatabaseFingerprint(urlText) {
  const url = new URL(urlText);
  return createHash('sha256').update(`${url.hostname}:${url.port || '5432'}:${url.pathname}:${url.username}`)
    .digest('hex');
}
function dumpConnection(urlText) {
  const url = new URL(urlText);
  const password = decodeURIComponent(url.password);
  url.password = '';
  return { url: url.toString(), password };
}
function processFailure(child, stderr) {
  return new Promise((resolve, reject) => {
    child.once('error', (error) => reject(Object.assign(new Error(`pg_dump could not start: ${error.message}`), {
      code: 'PG_DUMP_SPAWN_FAILED', cause: error,
    })));
    child.once('close', (code) => code === 0 ? resolve()
      : reject(new Error(`pg_dump failed (${code}): ${stderr.value.slice(-500)}`)));
  });
}

export async function validateBackupTools(env, { exec = execFileAsync } = {}) {
  for (const [name, path] of [['pg_dump', env.PG_DUMP_PATH ?? 'pg_dump'],
    ['pg_restore', env.PG_RESTORE_PATH ?? 'pg_restore']]) {
    try {
      await exec(path, ['--version'], { timeout: 5_000, windowsHide: true });
    } catch (error) {
      throw Object.assign(new Error(`${name} is unavailable at configured path`), {
        code: 'BACKUP_TOOL_UNAVAILABLE', cause: error,
      });
    }
  }
  return true;
}

export async function createEncryptedBackup({
  env,
  schemaVersion,
  reason = 'scheduled',
  backupId = uuidv7(),
  pgDumpPath = env.PG_DUMP_PATH ?? 'pg_dump',
  s3 = createS3Client(env),
  spawnProcess = spawn,
  upload = (client, params) => new Upload({ client, params }).done(),
}) {
  return withPostgresRootCertificate(env, async (rootCertificatePath) => {
    const id = backupId;
    const { version, key } = currentKey(env.BACKUP_ENCRYPTION_KEYS_JSON);
    const nonce = randomBytes(12);
    const sourceDbFingerprint = sourceDatabaseFingerprint(env.DATABASE_BACKUP_URL);
    const header = Buffer.from(JSON.stringify({ id, keyVersion: version, nonce: nonce.toString('base64'),
      schemaVersion, gitSha: env.GIT_SHA, appVersion: APP_VERSION, engineVersion: ENGINE_VERSION,
      executorVersion: EXECUTOR_VERSION, contractVersion: QUEST_CONTRACT_VERSION,
      runnerStateSchemaVersion: RUNNER_STATE_SCHEMA_VERSION, sourceDbFingerprint,
      createdAt: new Date().toISOString(), reason }));
    const prefix = Buffer.concat([MAGIC, Buffer.alloc(4), header]);
    prefix.writeUInt32BE(header.length, MAGIC.length);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(header);
    const connection = dumpConnection(env.DATABASE_BACKUP_URL);
    const processEnv = { ...process.env, PGPASSWORD: connection.password };
    delete processEnv.PGSSLROOTCERT;
    if (rootCertificatePath) processEnv.PGSSLROOTCERT = rootCertificatePath;
    const child = spawnProcess(pgDumpPath, ['--format=custom', '--no-owner', '--no-acl', `--dbname=${connection.url}`], {
      env: processEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = { value: '' };
    child.stderr.on('data', (chunk) => { stderr.value = `${stderr.value}${chunk}`.slice(-4000); });
    const childDone = processFailure(child, stderr);
    child.stdout.pipe(cipher);
    const hash = createHash('sha256');
    let size = 0;
    async function* encryptedBody() {
      hash.update(prefix); size += prefix.length; yield prefix;
      for await (const chunk of cipher) { hash.update(chunk); size += chunk.length; yield chunk; }
      await childDone;
      const tag = cipher.getAuthTag(); hash.update(tag); size += tag.length; yield tag;
    }
    const objectKey = `questshop/${new Date().toISOString().slice(0, 10)}/${id}.qsbk`;
    let uploadCompleted = false;
    try {
      await upload(s3, { Bucket: env.S3_BUCKET, Key: objectKey,
        Body: Readable.from(encryptedBody()), ContentType: 'application/octet-stream' });
      uploadCompleted = true;
    } finally {
      if (!uploadCompleted) {
        // S3 has already failed, so keeping a database dump alive cannot make
        // the backup recoverable. Stop it before the temporary CA is removed.
        child.stdout.unpipe(cipher);
        if (typeof child.kill === 'function' && !child.killed) child.kill('SIGTERM');
        void childDone.catch(() => {});
      }
    }
    const checksum = hash.digest('hex');
    const objectHead = await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey }));
    if (Number(objectHead.ContentLength) !== size) throw new Error('backup object size verification failed');
    const manifest = { id, objectKey, checksum, sizeBytes: size, schemaVersion, gitSha: env.GIT_SHA,
      appVersion: APP_VERSION, engineVersion: ENGINE_VERSION, executorVersion: EXECUTOR_VERSION,
      contractVersion: QUEST_CONTRACT_VERSION, runnerStateSchemaVersion: RUNNER_STATE_SCHEMA_VERSION,
      sourceDbFingerprint, encryptionKeyVersion: version, objectVersion: objectHead.VersionId ?? null,
      createdAt: new Date().toISOString(), reason };
    const manifestKey = `${objectKey}.json`;
    const manifestBody = Buffer.from(JSON.stringify(manifest));
    await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: manifestKey,
      Body: manifestBody, ContentType: 'application/json' }));
    const manifestHead = await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: manifestKey }));
    if (Number(manifestHead.ContentLength) !== manifestBody.length) {
      throw new Error('backup manifest size verification failed');
    }
    return { ...manifest, manifestKey };
  });
}

export async function downloadAndDecryptBackup({ env, objectKey, expectedChecksum = null,
  s3 = createS3Client(env) }) {
  const response = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey }));
  const iterator = response.Body[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  const readExact = async (length) => {
    while (buffered.length < length) {
      const next = await iterator.next();
      if (next.done) throw new Error('truncated QSBK1 backup');
      buffered = Buffer.concat([buffered, Buffer.from(next.value)]);
    }
    const value = buffered.subarray(0, length);
    buffered = buffered.subarray(length);
    return value;
  };
  const prefix = await readExact(MAGIC.length + 4);
  if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('invalid QSBK1 magic');
  const headerLength = prefix.readUInt32BE(MAGIC.length);
  if (headerLength <= 0 || headerLength > 64 * 1024) throw new Error('invalid QSBK1 header length');
  const header = await readExact(headerLength);
  const encryptedHash = createHash('sha256');
  encryptedHash.update(prefix); encryptedHash.update(header);
  const metadata = JSON.parse(header.toString('utf8'));
  const keyText = env.BACKUP_ENCRYPTION_KEYS_JSON.keys[String(metadata.keyVersion)];
  if (!keyText) throw new Error(`backup key version ${metadata.keyVersion} unavailable`);
  const totalLength = Number(response.ContentLength);
  const encryptedLength = totalLength - prefix.length - header.length;
  if (!Number.isSafeInteger(encryptedLength) || encryptedLength <= 16) {
    throw new Error('invalid QSBK1 content length');
  }
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyText, 'base64'), Buffer.from(metadata.nonce, 'base64'));
  decipher.setAAD(header);
  async function* plaintext() {
    let ciphertextRemaining = encryptedLength - 16;
    while (ciphertextRemaining > 0) {
      if (!buffered.length) {
        const next = await iterator.next();
        if (next.done) throw new Error('truncated QSBK1 ciphertext');
        buffered = Buffer.from(next.value);
      }
      const length = Math.min(buffered.length, ciphertextRemaining);
      const encrypted = buffered.subarray(0, length);
      buffered = buffered.subarray(length);
      ciphertextRemaining -= length;
      encryptedHash.update(encrypted);
      const clear = decipher.update(encrypted);
      if (clear.length) yield clear;
    }
    const tag = await readExact(16);
    encryptedHash.update(tag);
    const trailing = buffered.length || !(await iterator.next()).done;
    if (trailing) throw new Error('unexpected bytes after QSBK1 authentication tag');
    const checksum = encryptedHash.digest('hex');
    if (expectedChecksum && checksum !== expectedChecksum) throw new Error('QSBK1 checksum mismatch');
    decipher.setAuthTag(tag);
    const final = decipher.final();
    if (final.length) yield final;
  }
  return { metadata, dumpStream: Readable.from(plaintext()) };
}
