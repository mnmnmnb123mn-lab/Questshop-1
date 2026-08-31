import { readdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { configureSecretVerifier, fullIntegrityCheck, verifyKeyVerifier, withImmediateTransaction } from './sqlite.js';

function versionFromFilename(filename) {
  const match = /^(\d+)_.*\.sql$/.exec(filename);
  return match ? Number(match[1]) : null;
}

function assertFinancialMigrationPreflight(db, targetVersion) {
  if (targetVersion < 2) return;
  const invalid = db.prepare(`SELECT id,status,credited_cents,wallet_transaction_id,credited_at FROM topups
    WHERE (status='CREDITED' AND (credited_cents<=0 OR wallet_transaction_id IS NULL OR credited_at IS NULL))
      OR principal_cents<0 OR bonus_cents<0 OR credited_cents<0 LIMIT 1`).get();
  if (invalid) {
    const error = new Error(`SQLite financial preflight failed for Top-up ${invalid.id}`);
    error.code = 'SQLITE_MIGRATION_FINANCIAL_INVARIANT';
    error.details = { topupId: invalid.id, status: invalid.status };
    throw error;
  }
}

export function assertRequiredSchema(db, { version = Number(db.prepare('PRAGMA user_version').get().user_version), secret = null } = {}) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name));
  const required = ['settings', 'wallets', 'wallet_transactions', 'topups', 'payment_attempts', 'promotions',
    'quests', 'monitor_accounts', 'credentials', 'orders', 'order_items', 'jobs', 'quest_checks',
    'notifications', 'interaction_sessions', 'interaction_rate_limits', 'manual_reviews', 'settlement_evidence', 'external_operation_evidence', 'admin_audit', 'promotion_usages',
    ...(version >= 2 ? ['manual_review_confirmations'] : [])];
  const missing = required.filter((name) => !tables.has(name));
  if (missing.length) {
    const error = new Error(`SQLite migration is missing required tables: ${missing.join(', ')}`);
    error.code = 'SQLITE_SCHEMA_INCOMPLETE';
    throw error;
  }
  const requiredColumns = {
    topups: ['id', 'voucher_hmac_version', 'voucher_identity_hmac', 'voucher_hmac', 'status', 'prelaunch', 'state_version', 'wallet_transaction_id'],
    orders: ['id', 'credential_id', 'prelaunch', 'state', 'state_version'],
    quests: ['quest_id', 'task_type', 'thumbnail_url', 'starts_at', 'expires_at', 'target_value', 'orbs', 'orb_min', 'orb_max'],
    order_items: ['id', 'order_id', 'state', 'state_version'],
    notifications: ['id', 'desired_version', 'sending_version', 'delivered_version', 'attempt_version', 'nonce'],
    interaction_sessions: ['id', 'actor_id', 'guild_id', 'channel_id', 'message_id', 'operation', 'expires_at', 'consumed_at'],
    jobs: ['id', 'checkpoint', 'state_version', 'lease_token', 'lease_expires_at'],
    credentials: ['id', 'retention_class', 'cleanup_after', 'key_version'],
    manual_reviews: ['id', 'state_version', 'first_confirmation_by', 'decision'],
    promotions: ['id', 'state_version'],
    monitor_accounts: ['account_id', 'health_state', 'state_version'],
    interaction_rate_limits: ['discord_user_id', 'action', 'state_version'],
    ...(version >= 2 ? {
      payment_attempts: ['id', 'topup_id', 'attempt_number', 'parent_attempt_id', 'source', 'error_class', 'error_code', 'amount_cents', 'currency', 'receiver_confirmation'],
      manual_reviews: ['id', 'state_version', 'first_confirmation_by', 'decision', 'active_confirmation_round'],
      external_operation_evidence: ['id', 'job_id', 'operation_id', 'attempt_id', 'job_type', 'operation_key'],
      quests: ['quest_id', 'discovered_by_customer', 'discovered_by_monitor'],
    } : {}),
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const actual = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    const absent = columns.filter((column) => !actual.has(column));
    if (absent.length) {
      const error = new Error(`SQLite schema ${table} is missing columns: ${absent.join(', ')}`);
      error.code = 'SQLITE_SCHEMA_INCOMPLETE';
      throw error;
    }
  }
  const expectedTypes = version >= 2 ? {
    payment_attempts: { parent_attempt_id: 'TEXT', source: 'TEXT', error_class: 'TEXT', error_code: 'TEXT', amount_cents: 'INTEGER', currency: 'TEXT', receiver_confirmation: 'TEXT' },
    manual_review_confirmations: { confirmation_round: 'INTEGER', confirmation_step: 'INTEGER', payload_hash: 'TEXT', expires_at: 'INTEGER' },
    external_operation_evidence: { operation_id: 'TEXT', attempt_id: 'TEXT', job_type: 'TEXT', operation_key: 'TEXT' },
  } : {};
  for (const [table, types] of Object.entries(expectedTypes)) {
    const columns = new Map(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => [row.name, String(row.type).toUpperCase()]));
    for (const [column, type] of Object.entries(types)) {
      if (columns.get(column) !== type) {
        const error = new Error(`SQLite schema ${table}.${column} has incompatible type`);
        error.code = 'SQLITE_SCHEMA_INCOMPLETE';
        throw error;
      }
    }
  }
  for (const table of required) {
    const metadata = db.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get(table);
    if (!metadata || Number(metadata.strict) !== 1) {
      const error = new Error(`SQLite schema ${table} must be STRICT`);
      error.code = 'SQLITE_SCHEMA_INCOMPLETE';
      throw error;
    }
  }
  const indexes = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='index'").all().map((row) => row.name));
  const triggers = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all().map((row) => row.name));
  for (const index of ['manual_reviews_one_open', 'orders_one_active_quest_account', 'notifications_runnable', 'jobs_runnable',
    ...(version >= 2 ? ['manual_review_confirmations_lookup', 'payment_attempts_parent', 'monitor_test_one_active_per_quest'] : [])]) {
    if (!indexes.has(index)) {
      const error = new Error(`SQLite schema is missing index: ${index}`);
      error.code = 'SQLITE_SCHEMA_INCOMPLETE';
      throw error;
    }
  }
  for (const trigger of ['wallet_transactions_append_only_update', 'wallet_transactions_append_only_delete',
    'settlement_evidence_append_only_update', 'settlement_evidence_append_only_delete',
    'external_operation_evidence_append_only_update', 'external_operation_evidence_append_only_delete',
    'admin_audit_append_only_update', 'admin_audit_append_only_delete',
    'promotion_usages_append_only_update', 'promotion_usages_append_only_delete',
    ...(version >= 2 ? ['manual_review_confirmations_append_only_update', 'manual_review_confirmations_append_only_delete',
      'jobs_lease_integrity_insert', 'jobs_lease_integrity_update', 'notifications_lease_integrity_insert', 'notifications_lease_integrity_update',
      'topups_credit_integrity_insert', 'topups_credit_integrity_update',
      'order_items_capture_integrity_update', 'order_items_release_integrity_update',
      'manual_reviews_resolution_integrity_insert', 'manual_reviews_resolution_integrity_update'] : [])]) {
    if (!triggers.has(trigger)) {
      const error = new Error(`SQLite schema is missing append-only trigger: ${trigger}`);
      error.code = 'SQLITE_SCHEMA_INCOMPLETE';
      throw error;
    }
  }
  if (version > 0) {
    const verifier = db.prepare("SELECT value_json FROM settings WHERE key='secret_verifier'").get();
    let parsed;
    try { parsed = JSON.parse(verifier?.value_json ?? '{}'); } catch { parsed = null; }
    if (!parsed?.verifier || (secret != null && !verifyKeyVerifier(secret, parsed.verifier))) {
      const error = new Error('SQLite schema is missing a valid secret verifier');
      error.code = 'SQLITE_SECRET_MISMATCH';
      throw error;
    }
  }
}

export async function listSqliteMigrations(directory) {
  const entries = await readdir(directory);
  const migrations = entries.map((filename) => ({ filename, version: versionFromFilename(filename) }))
    .filter((entry) => Number.isInteger(entry.version)).sort((a, b) => a.version - b.version);
  let previous = 0;
  for (const migration of migrations) {
    if (migration.version !== previous + 1) {
      const error = new Error(`SQLite migrations must be contiguous and unique; expected v${previous + 1}, found v${migration.version}`);
      error.code = 'SQLITE_MIGRATION_SEQUENCE_INVALID';
      throw error;
    }
    previous = migration.version;
  }
  return migrations;
}

export async function migrateSqlite({ db, directory, secret, backup }) {
  const before = Number(db.prepare('PRAGMA user_version').get().user_version);
  const migrations = await listSqliteMigrations(directory);
  const latest = migrations.at(-1)?.version ?? 0;
  if (before > latest) {
    const error = new Error(`SQLite database version v${before} is newer than this runtime supports (v${latest})`);
    error.code = 'SQLITE_SCHEMA_AHEAD';
    throw error;
  }
  for (const migration of migrations) {
    if (migration.version <= before) continue;
    await backup(`pre-migration-v${migration.version}`);
    const sql = await readFile(path.join(directory, migration.filename), 'utf8');
    withImmediateTransaction(db, () => {
      assertFinancialMigrationPreflight(db, migration.version);
      db.exec(sql);
      configureSecretVerifier(db, secret);
      assertRequiredSchema(db, { version: migration.version, secret });
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
  }
  assertRequiredSchema(db, { version: latest, secret });
  const integrity = fullIntegrityCheck(db);
  if (!integrity.ok) {
    const error = new Error('SQLite integrity verification failed after migration');
    error.code = 'SQLITE_INTEGRITY_FAILED';
    error.details = integrity;
    throw error;
  }
  return { from: before, to: Number(db.prepare('PRAGMA user_version').get().user_version) };
}
