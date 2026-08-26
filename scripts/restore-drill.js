import '../src/config/load-local-environment.js';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { loadEnvironment, usesApplicationBackup } from '../src/config/env.js';
import { downloadAndDecryptBackup } from '../src/adapters/s3/backup.js';
import { withPostgresRootCertificate } from '../src/adapters/s3/postgres-tls.js';
import { getRuntimePool, closePools, postgresPoolOptions } from '../src/db/pools.js';
import { decryptSecret } from '../src/adapters/crypto/keyring.js';

const { Pool } = pg;
const env = loadEnvironment();
if (!usesApplicationBackup(env)) {
  throw new Error('Aiven-managed backup is active; Questshop cannot run a pg_restore drill');
}
const source = getRuntimePool(env);
const backup = (await source.query("SELECT * FROM backup_runs WHERE state='VERIFIED' ORDER BY completed_at DESC LIMIT 1")).rows[0];
if (!backup) throw new Error('No verified backup is available for restore drill');
const drillId = uuidv7();
await source.query(`INSERT INTO restore_drills(id,backup_run_id,state) VALUES($1,$2,'STARTED')`, [drillId, backup.id]);
const databaseName = `questshop_restore_${drillId.replaceAll('-', '')}`;
const direct = new URL(env.DATABASE_RESTORE_URL);
const password = decodeURIComponent(direct.password);
direct.password = '';
direct.pathname = '/postgres';
const admin = new Pool({ ...postgresPoolOptions(env, direct.toString()), password, max: 1 });
let target;
try {
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const restored = await downloadAndDecryptBackup({ env, objectKey: backup.object_key,
    expectedChecksum: backup.checksum });
  const targetUrl = new URL(direct); targetUrl.pathname = `/${databaseName}`;
  await withPostgresRootCertificate(env, async (rootCertificatePath) => {
    const processEnv = { ...process.env, PGPASSWORD: password };
    delete processEnv.PGSSLROOTCERT;
    if (rootCertificatePath) processEnv.PGSSLROOTCERT = rootCertificatePath;
    const child = spawn(env.PG_RESTORE_PATH ?? 'pg_restore', ['--no-owner', '--no-acl', `--dbname=${targetUrl}`], {
      env: processEnv,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    const restoreInput = pipeline(restored.dumpStream, child.stdin);
    const waitForRestore = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const [code] = await Promise.all([waitForRestore, restoreInput]);
    if (code !== 0) throw new Error(`pg_restore failed (${code}): ${stderr}`);
  });
  target = new Pool({ ...postgresPoolOptions(env, targetUrl.toString()), password, max: 1 });
  const receiver = (await target.query(`SELECT * FROM receiver_versions
    ORDER BY version DESC LIMIT 1`)).rows[0];
  if (receiver) decryptSecret({ keyVersion: receiver.encryption_key_version,
    nonce: receiver.nonce, ciphertext: receiver.encrypted_phone, authTag: receiver.auth_tag },
  env.DATA_ENCRYPTION_KEYS_JSON, `receiver:${receiver.id}:${env.DISCORD_GUILD_ID}`);
  const checks = {
    schema: Number((await target.query('SELECT max(version) AS value FROM schema_migrations')).rows[0].value) === Number(backup.schema_version),
    walletNonnegative: Number((await target.query('SELECT count(*) AS count FROM wallets WHERE available_cents<0 OR reserved_cents<0')).rows[0].count) === 0,
    walletMatchesLedger: Number((await target.query(`SELECT count(*) AS count FROM wallets w
      LEFT JOIN LATERAL (SELECT available_after_cents,reserved_after_cents FROM wallet_transactions t
        WHERE t.discord_user_id=w.discord_user_id ORDER BY t.created_at DESC,t.id DESC LIMIT 1) t ON true
      LEFT JOIN LATERAL (SELECT available_cents,reserved_cents FROM wallet_checkpoints c
        WHERE c.discord_user_id=w.discord_user_id ORDER BY c.created_at DESC LIMIT 1) c ON true
      WHERE w.available_cents<>COALESCE(t.available_after_cents,c.available_cents,0)
        OR w.reserved_cents<>COALESCE(t.reserved_after_cents,c.reserved_cents,0)`)).rows[0].count) === 0,
    reservationsBalanced: Number((await target.query(`SELECT count(*) AS count FROM wallets w
      LEFT JOIN (SELECT discord_user_id,sum(amount_cents)::bigint AS amount FROM wallet_reservations
        WHERE state='RESERVED' GROUP BY discord_user_id) r USING(discord_user_id)
      WHERE w.reserved_cents<>COALESCE(r.amount,0)`)).rows[0].count) === 0,
    creditedPaymentsHaveLedger: Number((await target.query(`SELECT count(*) AS count FROM topups t
      WHERE t.status='CREDITED' AND NOT EXISTS(SELECT 1 FROM wallet_transactions w
        WHERE w.reference_type='TOPUP' AND w.reference_id=t.id::text
          AND w.transaction_type='TOPUP_CREDIT')`)).rows[0].count) === 0,
    queueReferencesValid: Number((await target.query(`SELECT count(*) AS count FROM runner_jobs j
      LEFT JOIN order_items i ON i.id=j.order_item_id WHERE i.id IS NULL`)).rows[0].count) === 0,
    outboxReferencesValid: Number((await target.query(`SELECT count(*) AS count FROM outbox_events o
      LEFT JOIN message_projections p ON p.id=o.projection_id
      WHERE o.projection_id IS NOT NULL AND p.id IS NULL`)).rows[0].count) === 0,
    checkpointsHashed: Number((await target.query(`SELECT count(*) AS count FROM wallet_checkpoints
      WHERE chain_hash !~ '^[a-f0-9]{64}$'`)).rows[0].count) === 0,
    cryptoDecryptable: true,
  };
  if (Object.values(checks).some((value) => !value)) throw new Error('restore invariant check failed');
  await source.query(`UPDATE restore_drills SET state='VERIFIED',checks=$2,completed_at=clock_timestamp() WHERE id=$1`, [drillId, checks]);
  console.log(JSON.stringify({ ok: true, drillId, backupId: backup.id, checks }));
} catch (error) {
  await source.query(`UPDATE restore_drills SET state='FAILED',error_code=$2,completed_at=clock_timestamp() WHERE id=$1`, [drillId, error.code ?? error.name]).catch(() => null);
  await source.query(`INSERT INTO incidents(id,incident_code,scope,state,severity,evidence,trace_id)
    VALUES($1,'RESTORE_DRILL_FAILED','DATABASE','OPEN','CRITICAL',$2,$3)
    ON CONFLICT (incident_code,scope) WHERE state<>'RESOLVED' DO UPDATE SET
      severity=EXCLUDED.severity,evidence=EXCLUDED.evidence,updated_at=clock_timestamp()`,
  [uuidv7(), { drillId, backupId: backup.id, errorCode: error.code ?? error.name }, uuidv7()]).catch(() => null);
  throw error;
} finally {
  await target?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`).catch(() => null);
  await admin.end();
  await closePools();
}
