import { readdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { configureSecretVerifier, fullIntegrityCheck, withImmediateTransaction } from './sqlite.js';

function versionFromFilename(filename) {
  const match = /^(\d+)_.*\.sql$/.exec(filename);
  return match ? Number(match[1]) : null;
}

export function assertRequiredSchema(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name));
  const required = ['settings', 'wallets', 'wallet_transactions', 'topups', 'payment_attempts', 'promotions',
    'quests', 'monitor_accounts', 'credentials', 'orders', 'order_items', 'jobs', 'quest_checks',
    'notifications', 'interaction_sessions', 'interaction_rate_limits', 'manual_reviews', 'settlement_evidence', 'external_operation_evidence', 'admin_audit', 'promotion_usages'];
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
  const indexes = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='index'").all().map((row) => row.name));
  const triggers = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all().map((row) => row.name));
  for (const index of ['manual_reviews_one_open', 'orders_one_active_quest_account', 'notifications_runnable', 'jobs_runnable']) {
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
    'promotion_usages_append_only_update', 'promotion_usages_append_only_delete']) {
    if (!triggers.has(trigger)) {
      const error = new Error(`SQLite schema is missing append-only trigger: ${trigger}`);
      error.code = 'SQLITE_SCHEMA_INCOMPLETE';
      throw error;
    }
  }
}

export async function listSqliteMigrations(directory) {
  const entries = await readdir(directory);
  return entries.map((filename) => ({ filename, version: versionFromFilename(filename) }))
    .filter((entry) => Number.isInteger(entry.version)).sort((a, b) => a.version - b.version);
}

export async function migrateSqlite({ db, directory, secret, backup }) {
  const before = Number(db.prepare('PRAGMA user_version').get().user_version);
  const migrations = await listSqliteMigrations(directory);
  for (const migration of migrations) {
    if (migration.version <= before) continue;
    await backup(`pre-migration-v${migration.version}`);
    const sql = await readFile(path.join(directory, migration.filename), 'utf8');
    withImmediateTransaction(db, () => {
      db.exec(sql);
      configureSecretVerifier(db, secret);
      assertRequiredSchema(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
  }
  const integrity = fullIntegrityCheck(db);
  if (!integrity.ok) {
    const error = new Error('SQLite integrity verification failed after migration');
    error.code = 'SQLITE_INTEGRITY_FAILED';
    error.details = integrity;
    throw error;
  }
  return { from: before, to: Number(db.prepare('PRAGMA user_version').get().user_version) };
}
