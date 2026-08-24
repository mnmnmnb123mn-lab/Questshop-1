function missingVersions(required, keyring) {
  const available = new Set(Object.keys(keyring.keys).map(Number));
  return required.map(Number).filter((version) => !available.has(version));
}

function assertCovered(label, required, keyring) {
  if (required.length && !keyring) throw Object.assign(new Error(`${label} keyring is not configured`), {
    code: 'KEYRING_VERSION_MISSING', keyring: label, missingVersions: required,
  });
  const missing = missingVersions(required, keyring);
  if (missing.length) throw Object.assign(new Error(`${label} keyring is missing required versions: ${missing.join(', ')}`), {
    code: 'KEYRING_VERSION_MISSING', keyring: label, missingVersions: missing,
  });
}

export async function validateKeyringCoverage(pool, env) {
  const data = (await pool.query(`SELECT DISTINCT version FROM (
    SELECT key_version AS version FROM checkout_credentials
    UNION SELECT key_version FROM order_credentials
    UNION SELECT key_version FROM monitor_credentials
    UNION SELECT key_version FROM topup_sensitive_payloads
    UNION SELECT encryption_key_version FROM receiver_versions
  ) versions ORDER BY version`)).rows.map((row) => row.version);
  const vouchers = (await pool.query(`SELECT DISTINCT t.voucher_hmac_version AS version FROM topups t
    WHERE t.status NOT IN ('CREDITED','INVALID','EXPIRED','ALREADY_REDEEMED','FAILED','REJECTED','REVERSED')
      OR t.updated_at>=clock_timestamp()-interval '180 days'
      OR EXISTS(SELECT 1 FROM manual_reviews r WHERE r.subject_type='TOPUP'
        AND r.subject_id=t.id::text AND r.state<>'RESOLVED')
    ORDER BY version`)).rows.map((row) => row.version);
  const backups = (await pool.query(`SELECT DISTINCT encryption_key_version AS version FROM backup_runs
    WHERE state='VERIFIED' AND object_key IS NOT NULL ORDER BY version`)).rows.map((row) => row.version);
  assertCovered('DATA_ENCRYPTION', data, env.DATA_ENCRYPTION_KEYS_JSON);
  assertCovered('VOUCHER_HMAC', vouchers, env.VOUCHER_HMAC_KEYS_JSON);
  // Backup encryption is optional outside production.  An empty backup
  // history therefore must not make a non-backup runtime dereference an
  // absent keyring; once a verified backup exists, the keyring is mandatory.
  if (backups.length) assertCovered('BACKUP_ENCRYPTION', backups, env.BACKUP_ENCRYPTION_KEYS_JSON);
  return { data, vouchers, backups };
}
