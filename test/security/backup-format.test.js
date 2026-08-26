import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers';
import { access, readFile, stat } from 'node:fs/promises';
import { createEncryptedBackup, downloadAndDecryptBackup, validateBackupTools } from '../../src/adapters/s3/backup.js';
import { withPostgresRootCertificate } from '../../src/adapters/s3/postgres-tls.js';

const MAGIC = Buffer.from('QSBK1');
const key = Buffer.alloc(32, 11);
const keyring = { current: 1, keys: { 1: key.toString('base64') } };

function databaseUrl(role, password = null) {
  const url = new URL(['postgresql', ':', '/', '/db.example.invalid'].join(''));
  url.username = role;
  if (password) url.password = password;
  url.hostname = 'db.example.invalid';
  url.pathname = '/questshop_test';
  return url.toString();
}

function fixture(plaintext, { tamperTag = false } = {}) {
  const nonce = Buffer.alloc(12, 3);
  const header = Buffer.from(JSON.stringify({ keyVersion: 1, nonce: nonce.toString('base64'),
    schemaVersion: 11, gitSha: 'test-sha' }));
  const prefix = Buffer.concat([MAGIC, Buffer.alloc(4)]);
  prefix.writeUInt32BE(header.length, MAGIC.length);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tamperTag) tag[0] ^= 0xff;
  const body = Buffer.concat([prefix, header, encrypted, tag]);
  return { body, checksum: createHash('sha256').update(body).digest('hex') };
}

async function decode(value, expectedChecksum = value.checksum) {
  const chunks = [value.body.subarray(0, 3), value.body.subarray(3, 19),
    value.body.subarray(19, 47), value.body.subarray(47)];
  const s3 = { send: async () => ({ Body: Readable.from(chunks), ContentLength: value.body.length }) };
  const result = await downloadAndDecryptBackup({ env: { S3_BUCKET: 'test',
    BACKUP_ENCRYPTION_KEYS_JSON: keyring }, objectKey: 'fixture.qsbk', expectedChecksum, s3 });
  const clear = [];
  for await (const chunk of result.dumpStream) clear.push(chunk);
  return { metadata: result.metadata, plaintext: Buffer.concat(clear) };
}

test('QSBK1 restore streams arbitrary chunks and verifies checksum plus GCM tag', async () => {
  const clear = Buffer.from('pg_dump custom fixture'.repeat(4096));
  const value = fixture(clear);
  const decoded = await decode(value);
  assert.deepEqual(decoded.plaintext, clear);
  assert.equal(decoded.metadata.schemaVersion, 11);
  await assert.rejects(() => decode(value, '0'.repeat(64)), /checksum mismatch/);
  await assert.rejects(() => decode(fixture(clear, { tamperTag: true })), /authenticate data/);
});

test('backup creation streams a pg_dump through encryption then verifies uploaded object and manifest', async () => {
  const testPassword = Buffer.alloc(12, 7).toString('hex');
  const objects = new Map();
  const s3 = { send: async (command) => {
    const { Key, Body } = command.input;
    if (Body) {
      if (Buffer.isBuffer(Body)) objects.set(Key, Body);
      else {
        const chunks = [];
        for await (const chunk of Body) chunks.push(Buffer.from(chunk));
      objects.set(Key, Buffer.concat(chunks));
      }
      return {};
    }
    const object = objects.get(Key);
    if (!object) throw new Error(`missing fake S3 object: ${Key}`);
    if (command.constructor.name === 'GetObjectCommand') {
      return { Body: Readable.from([object]), ContentLength: object.length };
    }
    return { ContentLength: object.length, VersionId: 'fake-version-1' };
  } };
  const clear = Buffer.from('custom-format-pg-dump'.repeat(8_192));
  let rootCertificatePath;
  let rootCertificateContents;
  const spawnProcess = (binary, args, options) => {
    assert.equal(binary, '/usr/local/bin/pg_dump');
    assert.ok(args.includes('--format=custom'));
    assert.equal(options.env.PGPASSWORD, testPassword);
    rootCertificatePath = options.env.PGSSLROOTCERT;
    rootCertificateContents = readFile(rootCertificatePath);
    const child = new EventEmitter();
    child.stdout = Readable.from([clear]);
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const upload = async (_client, params) => {
    const chunks = [];
    for await (const chunk of params.Body) chunks.push(Buffer.from(chunk));
    objects.set(params.Key, Buffer.concat(chunks));
  };
  const env = { S3_BUCKET: 'test', GIT_SHA: 'test-sha',
    DATABASE_BACKUP_URL: databaseUrl('backup', testPassword),
    DATABASE_SSL_CA_BASE64: Buffer.from('test-root-certificate').toString('base64'),
    BACKUP_ENCRYPTION_KEYS_JSON: keyring, PG_DUMP_PATH: '/usr/local/bin/pg_dump' };
  const backup = await createEncryptedBackup({ env, schemaVersion: 13, reason: 'test',
    backupId: '019fc530-2000-7000-8000-000000000001', s3, spawnProcess, upload });
  assert.equal(backup.objectVersion, 'fake-version-1');
  assert.ok(objects.has(backup.objectKey));
  assert.ok(objects.has(backup.manifestKey));
  const manifest = JSON.parse(objects.get(backup.manifestKey).toString('utf8'));
  assert.equal(manifest.appVersion, '0.1.0');
  assert.equal(manifest.engineVersion, '1.0.0');
  assert.equal(manifest.objectVersion, 'fake-version-1');
  assert.equal(manifest.sourceDbFingerprint.length, 64);
  const restored = await downloadAndDecryptBackup({ env, objectKey: backup.objectKey,
    expectedChecksum: backup.checksum, s3 });
  const chunks = [];
  for await (const chunk of restored.dumpStream) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), clear);
  assert.equal(restored.metadata.schemaVersion, 13);
  assert.equal((await rootCertificateContents).toString('utf8'), 'test-root-certificate');
  await assert.rejects(() => access(rootCertificatePath));
});

test('backup tools are validated through configured executable paths', async () => {
  const calls = [];
  await validateBackupTools({ PG_DUMP_PATH: '/opt/postgres/bin/pg_dump', PG_RESTORE_PATH: '/opt/postgres/bin/pg_restore' }, {
    exec: async (binary, args) => { calls.push({ binary, args }); return { stdout: `${binary} 16`, stderr: '' }; },
  });
  assert.deepEqual(calls, [
    { binary: '/opt/postgres/bin/pg_dump', args: ['--version'] },
    { binary: '/opt/postgres/bin/pg_restore', args: ['--version'] },
  ]);
  await assert.rejects(() => validateBackupTools({ PG_DUMP_PATH: 'missing-pg_dump', PG_RESTORE_PATH: 'pg_restore' }, {
    exec: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  }), (error) => error.code === 'BACKUP_TOOL_UNAVAILABLE' && /pg_dump/.test(error.message));
});

test('PostgreSQL tool CA exists only while its child-process action runs', async () => {
  let certificatePath;
  await withPostgresRootCertificate({ DATABASE_SSL_CA_BASE64: Buffer.from('private-ca').toString('base64') }, async (path) => {
    certificatePath = path;
    assert.equal((await readFile(path)).toString('utf8'), 'private-ca');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
  await assert.rejects(() => access(certificatePath));
  let publicRootPath = 'not-called';
  await withPostgresRootCertificate({}, async (path) => { publicRootPath = path; });
  assert.equal(publicRootPath, null);
});

test('backup clears inherited PGSSLROOTCERT when managed PostgreSQL uses a public trusted root', async () => {
  const s3 = { send: async (command) => {
    if (command.input.Body) return {};
    return { ContentLength: 5, VersionId: 'version' };
  } };
  const spawnProcess = (_binary, _args, options) => {
    assert.equal(options.env.PGSSLROOTCERT, undefined);
    const child = new EventEmitter(); child.stdout = Readable.from([Buffer.from('dump')]);
    child.stderr = new EventEmitter(); setImmediate(() => child.emit('close', 0)); return child;
  };
  const previous = process.env.PGSSLROOTCERT;
  try {
    process.env.PGSSLROOTCERT = '/unexpected/inherited-ca.pem';
    await assert.rejects(() => createEncryptedBackup({
      env: { S3_BUCKET: 'test', GIT_SHA: 'test-sha', DATABASE_BACKUP_URL: databaseUrl('backup'),
        BACKUP_ENCRYPTION_KEYS_JSON: keyring, PG_DUMP_PATH: 'pg_dump' }, schemaVersion: 1, s3, spawnProcess,
      upload: async () => { throw new Error('stop after process environment assertion'); },
    }), /stop after process environment assertion/);
  } finally {
    if (previous == null) delete process.env.PGSSLROOTCERT;
    else process.env.PGSSLROOTCERT = previous;
  }
});

test('S3 upload failure terminates the in-flight pg_dump before temporary TLS cleanup', async () => {
  let killed = 0;
  await assert.rejects(() => createEncryptedBackup({
    env: { S3_BUCKET: 'test', GIT_SHA: 'test-sha',
      DATABASE_BACKUP_URL: databaseUrl('backup'),
      DATABASE_SSL_CA_BASE64: Buffer.from('test-root-certificate').toString('base64'),
      BACKUP_ENCRYPTION_KEYS_JSON: keyring, PG_DUMP_PATH: 'pg_dump' },
    schemaVersion: 13,
    s3: {},
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = Readable.from([Buffer.from('in-flight-dump')]);
      child.stderr = new EventEmitter();
      child.kill = () => { killed += 1; child.killed = true; setImmediate(() => child.emit('close', 1)); };
      return child;
    },
    upload: async () => { throw new Error('S3 unavailable'); },
  }), /S3 unavailable/);
  assert.equal(killed, 1);
});
