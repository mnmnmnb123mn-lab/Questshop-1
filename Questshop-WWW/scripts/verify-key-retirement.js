import '../src/config/load-local-environment.js';
import { loadEnvironment } from '../src/config/env.js';
import { closeDirectPool, getDirectPool } from '../src/db/pools.js';

const env = loadEnvironment();
const dataVersion = Number(process.env.QUESTSHOP_RETIRE_DATA_KEY_VERSION);
const voucherVersion = Number(process.env.QUESTSHOP_RETIRE_VOUCHER_KEY_VERSION);
const backupVersion = Number(process.env.QUESTSHOP_RETIRE_BACKUP_KEY_VERSION);
if (!Number.isInteger(dataVersion) && !Number.isInteger(voucherVersion) && !Number.isInteger(backupVersion)) {
  throw new TypeError('Set QUESTSHOP_RETIRE_DATA_KEY_VERSION, QUESTSHOP_RETIRE_VOUCHER_KEY_VERSION and/or QUESTSHOP_RETIRE_BACKUP_KEY_VERSION');
}
if (dataVersion === env.DATA_ENCRYPTION_KEYS_JSON.current || voucherVersion === env.VOUCHER_HMAC_KEYS_JSON.current
  || backupVersion === env.BACKUP_ENCRYPTION_KEYS_JSON?.current) {
  throw new Error('The active key version cannot be retired');
}

if (env.BACKUP_MODE === 'AIVEN_MANAGED') {
  // Aiven owns backups that Questshop cannot enumerate or restore-test. A
  // provider snapshot can still contain rows encrypted/HMACed by an older
  // version, so removing any old key would make an emergency restore unsafe.
  console.log(JSON.stringify({ ok: false, backupMode: env.BACKUP_MODE,
    next: 'Keep retired key versions: Aiven-managed backups cannot be inspected or restore-drilled by Questshop.' }));
  process.exitCode = 2;
} else {

  const pool = getDirectPool(env);
  try {
  const [dataReferences, voucherReferences, backupReferences, restore] = await Promise.all([
    Number.isInteger(dataVersion) ? pool.query(`SELECT count(*)::integer AS count FROM (
      SELECT key_version AS version FROM checkout_credentials
      UNION ALL SELECT key_version FROM order_credentials
      UNION ALL SELECT key_version FROM monitor_credentials
      UNION ALL SELECT key_version FROM topup_sensitive_payloads
      UNION ALL SELECT encryption_key_version FROM receiver_versions
    ) values WHERE version=$1`, [dataVersion]) : { rows: [{ count: 0 }] },
    Number.isInteger(voucherVersion) ? pool.query(`SELECT count(*)::integer AS count FROM topups
      WHERE voucher_hmac_version=$1 AND (status NOT IN ('CREDITED','INVALID','EXPIRED','ALREADY_REDEEMED',
        'FAILED','REJECTED','REVERSED') OR updated_at>=clock_timestamp()-interval '180 days'
        OR EXISTS(SELECT 1 FROM manual_reviews r WHERE r.subject_type='TOPUP'
          AND r.subject_id=topups.id::text AND r.state<>'RESOLVED'))`, [voucherVersion]) : { rows: [{ count: 0 }] },
    Number.isInteger(backupVersion) ? pool.query(`SELECT count(*)::integer AS count FROM backup_runs
      WHERE encryption_key_version=$1 AND state IN ('STARTED','VERIFIED')`, [backupVersion]) : { rows: [{ count: 0 }] },
    pool.query(`SELECT r.completed_at,b.encryption_key_version FROM restore_drills r
      JOIN backup_runs b ON b.id=r.backup_run_id
      WHERE r.state='VERIFIED' ORDER BY r.completed_at DESC LIMIT 1`),
  ]);
  const verifiedRestoreAt = restore.rows[0]?.completed_at ?? null;
  const restoreUsesRetiringBackupKey = Number.isInteger(backupVersion)
    && Number(restore.rows[0]?.encryption_key_version) === backupVersion;
  const ready = Number(dataReferences.rows[0].count) === 0
    && Number(voucherReferences.rows[0].count) === 0 && Number(backupReferences.rows[0].count) === 0
    && verifiedRestoreAt != null && !restoreUsesRetiringBackupKey;
  console.log(JSON.stringify({ ok: ready, dataVersion: Number.isInteger(dataVersion) ? dataVersion : null,
    voucherVersion: Number.isInteger(voucherVersion) ? voucherVersion : null,
    backupVersion: Number.isInteger(backupVersion) ? backupVersion : null,
    dataReferences: Number(dataReferences.rows[0].count), voucherReferences: Number(voucherReferences.rows[0].count),
    backupReferences: Number(backupReferences.rows[0].count), verifiedRestoreAt,
    restoreUsesRetiringBackupKey, next: ready
      ? 'Remove the retired version from durable secret storage, redeploy, then run setup-preflight.'
      : 'Re-encrypt remaining data, wait for voucher retention/reviews and old backups to clear, then complete a restore drill.' }));
  if (!ready) process.exitCode = 2;
  } finally {
    await closeDirectPool();
  }
}
