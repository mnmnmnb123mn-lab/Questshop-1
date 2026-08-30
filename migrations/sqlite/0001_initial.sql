CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS wallets (
  discord_user_id TEXT PRIMARY KEY,
  available_cents INTEGER NOT NULL DEFAULT 0 CHECK (available_cents >= 0),
  reserved_cents INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL REFERENCES wallets(discord_user_id),
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('TOPUP','RESERVE','CAPTURE','RELEASE','REFUND','REVERSAL','ADJUSTMENT')),
  available_delta_cents INTEGER NOT NULL,
  reserved_delta_cents INTEGER NOT NULL,
  available_after_cents INTEGER NOT NULL CHECK (available_after_cents >= 0),
  reserved_after_cents INTEGER NOT NULL CHECK (reserved_after_cents >= 0),
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  trace_id TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TRIGGER IF NOT EXISTS wallet_transactions_append_only_update
BEFORE UPDATE ON wallet_transactions BEGIN SELECT RAISE(ABORT, 'wallet_transactions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS wallet_transactions_append_only_delete
BEFORE DELETE ON wallet_transactions BEGIN SELECT RAISE(ABORT, 'wallet_transactions is append-only'); END;

CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','INACTIVE')),
  rule_json TEXT NOT NULL CHECK (json_valid(rule_json)),
  starts_at INTEGER,
  ends_at INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS promotions_one_active ON promotions(state) WHERE state='ACTIVE';

CREATE TABLE IF NOT EXISTS quests (
  quest_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  task_type TEXT NOT NULL,
  url TEXT NOT NULL,
  artwork_url TEXT,
  thumbnail_url TEXT,
  starts_at INTEGER,
  expires_at INTEGER,
  target_value INTEGER,
  orbs INTEGER,
  orb_min INTEGER,
  orb_max INTEGER,
  contract_hash TEXT,
  source TEXT NOT NULL CHECK (source IN ('CUSTOMER','MONITOR')),
  announcement_status TEXT NOT NULL DEFAULT 'NOT_ANNOUNCED' CHECK (announcement_status IN ('NOT_ANNOUNCED','QUEUED','ANNOUNCED')),
  monitor_status TEXT NOT NULL DEFAULT 'NOT_CHECKED' CHECK (monitor_status IN ('NOT_CHECKED','FOUND_READY','FOUND_COMPLETED','NOT_FOUND','INCOMPLETE','TEST_PASSED','TEST_FAILED')),
  discovery_count INTEGER NOT NULL DEFAULT 1 CHECK (discovery_count > 0),
  first_discovered_by TEXT,
  last_discovered_by TEXT,
  first_account_id TEXT,
  last_account_id TEXT,
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS monitor_accounts (
  account_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','COOLDOWN','DISABLED')),
  credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,
  cooldown_until INTEGER,
  last_checked_at INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  key_version TEXT NOT NULL DEFAULT 'v1' CHECK (key_version GLOB 'v[0-9]*'),
  retention_class TEXT NOT NULL CHECK (retention_class IN ('TEMPORARY','PERSISTENT')),
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  auth_tag BLOB NOT NULL,
  cleanup_after INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(subject_type, subject_id, credential_type),
  CHECK ((retention_class='TEMPORARY' AND cleanup_after IS NOT NULL) OR (retention_class='PERSISTENT' AND cleanup_after IS NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS credentials_cleanup ON credentials(retention_class, cleanup_after);

CREATE TABLE IF NOT EXISTS topups (
  id TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  voucher_hmac_version TEXT NOT NULL DEFAULT 'v1' CHECK (voucher_hmac_version GLOB 'v[0-9]*'),
  voucher_identity_hmac BLOB NOT NULL UNIQUE,
  voucher_hmac BLOB NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('PENDING','PROCESSING','REDEEMED','CREDITED','FAILED','REVIEW','REVERSED')),
  prelaunch INTEGER NOT NULL DEFAULT 0 CHECK (prelaunch IN (0,1)),
  principal_cents INTEGER NOT NULL DEFAULT 0 CHECK (principal_cents >= 0),
  bonus_cents INTEGER NOT NULL DEFAULT 0 CHECK (bonus_cents >= 0),
  credited_cents INTEGER NOT NULL DEFAULT 0 CHECK (credited_cents >= 0),
  promotion_snapshot_json TEXT,
  provider_transaction_id TEXT UNIQUE,
  receiver_last4 TEXT,
  wallet_transaction_id TEXT UNIQUE REFERENCES wallet_transactions(id),
  failure_reason TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
  trace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  credited_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS topups_owner_created ON topups(discord_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS topups_recovery ON topups(status, updated_at);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id TEXT PRIMARY KEY,
  topup_id TEXT NOT NULL REFERENCES topups(id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  dispatch_state TEXT NOT NULL CHECK (dispatch_state IN ('INTENT_RECORDED','POSSIBLY_SENT','RESPONSE_RECEIVED','CONFIRMED_NOT_SENT')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('SUCCESS','DEFINITE_FAILURE','AMBIGUOUS')),
  provider_http_status INTEGER,
  provider_code TEXT,
  provider_reference TEXT,
  reason_code TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
  trace_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(topup_id, attempt_number)
) STRICT;

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  quest_account_id TEXT NOT NULL,
  credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,
  prelaunch INTEGER NOT NULL DEFAULT 0 CHECK (prelaunch IN (0,1)),
  state TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','COMPLETED','PARTIAL','CANCELLED','REVIEW')),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  trace_id TEXT NOT NULL,
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  quest_id TEXT NOT NULL REFERENCES quests(quest_id),
  state TEXT NOT NULL CHECK (state IN ('QUEUED','RUNNING','READY_TO_CLAIM','FAILED','REVIEW','REFUNDED')),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  claim_url TEXT,
  refund_cents INTEGER NOT NULL DEFAULT 0 CHECK (refund_cents >= 0),
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
  reserved_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(order_id, quest_id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS orders_one_checkout_credential
  ON orders(credential_id) WHERE credential_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_one_active_quest_account
  ON orders(quest_account_id) WHERE state IN ('PENDING','RUNNING','REVIEW');

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','RETRY_WAIT','COMPLETED','FAILED','REVIEW')),
  checkpoint TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK (checkpoint IN ('NOT_STARTED','INTENT_RECORDED','POSSIBLY_SENT','VERIFIED')),
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_run_at INTEGER NOT NULL,
  last_error_code TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  lease_token TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS jobs_runnable ON jobs(state, next_run_at, created_at);

CREATE TABLE IF NOT EXISTS quest_checks (
  id TEXT PRIMARY KEY,
  quest_id TEXT NOT NULL REFERENCES quests(quest_id),
  monitor_account_id TEXT NOT NULL REFERENCES monitor_accounts(account_id),
  batch_id TEXT NOT NULL,
  check_type TEXT NOT NULL CHECK (check_type IN ('SEARCH','TEST')),
  state TEXT NOT NULL CHECK (state IN ('FOUND','COMPLETED','NOT_FOUND','UNAVAILABLE','PASSED','FAILED','REVIEW')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  safe_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(quest_id, monitor_account_id, batch_id, check_type)
) STRICT;

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  notification_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  message_id TEXT,
  nonce TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('PENDING','SENDING','RETRY_WAIT','DELIVERED','DEAD_LETTER')),
  desired_version INTEGER NOT NULL DEFAULT 1,
  sending_version INTEGER,
  delivered_version INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  attempt_version INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  last_error_code TEXT,
  lease_token TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(notification_type, aggregate_type, aggregate_id, destination)
) STRICT;
CREATE INDEX IF NOT EXISTS notifications_runnable ON notifications(state, next_run_at, created_at);

-- Opaque server-side records for persistent components.  The custom ID only
-- carries this UUID; actor/context/operation/payload remain in SQLite.
CREATE TABLE IF NOT EXISTS interaction_sessions (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS interaction_sessions_expiry ON interaction_sessions(expires_at);

CREATE TABLE IF NOT EXISTS manual_reviews (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('FINANCIAL','OPERATIONAL')),
  state TEXT NOT NULL CHECK (state IN ('OPEN','RESOLVED_SUCCESS','RESOLVED_FAILURE')),
  reason_code TEXT NOT NULL,
  safe_reason TEXT,
  first_confirmation_by TEXT,
  first_confirmation_at INTEGER,
  decision TEXT,
  resolved_by TEXT,
  resolved_at INTEGER,
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((state='OPEN' AND resolved_at IS NULL AND decision IS NULL) OR
    (state IN ('RESOLVED_SUCCESS','RESOLVED_FAILURE') AND resolved_at IS NOT NULL AND decision IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS manual_reviews_one_open
  ON manual_reviews(subject_type, subject_id) WHERE state='OPEN';

-- Settlement evidence is deliberately separate from mutable aggregates.  It
-- records why a reserved Item was captured, released, or retained for review
-- without allowing a later update/delete to rewrite the financial history.
CREATE TABLE IF NOT EXISTS settlement_evidence (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('CAPTURED','RELEASED','REVIEWED')),
  reason_code TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
  trace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(subject_type, subject_id, outcome)
) STRICT;
CREATE INDEX IF NOT EXISTS settlement_evidence_subject ON settlement_evidence(subject_type, subject_id, created_at);
CREATE TRIGGER IF NOT EXISTS settlement_evidence_append_only_update
BEFORE UPDATE ON settlement_evidence BEGIN SELECT RAISE(ABORT, 'settlement_evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS settlement_evidence_append_only_delete
BEFORE DELETE ON settlement_evidence BEGIN SELECT RAISE(ABORT, 'settlement_evidence is append-only'); END;

-- A worker must leave an immutable trail around every external operation.
-- This is deliberately separate from the mutable job checkpoint so restart
-- recovery can distinguish a request that was never sent from one that may
-- have reached a provider.
CREATE TABLE IF NOT EXISTS external_operation_evidence (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('INTENT','POSSIBLY_SENT','VERIFIED_RESULT','AMBIGUOUS','RECOVERY_DECISION')),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
  trace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(job_id, stage)
) STRICT;
CREATE INDEX IF NOT EXISTS external_operation_evidence_subject
  ON external_operation_evidence(subject_type, subject_id, created_at);
CREATE TRIGGER IF NOT EXISTS external_operation_evidence_append_only_update
BEFORE UPDATE ON external_operation_evidence BEGIN SELECT RAISE(ABORT, 'external_operation_evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS external_operation_evidence_append_only_delete
BEFORE DELETE ON external_operation_evidence BEGIN SELECT RAISE(ABORT, 'external_operation_evidence is append-only'); END;

CREATE TABLE IF NOT EXISTS admin_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT,
  before_json TEXT,
  after_json TEXT,
  trace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS admin_audit_append_only_update
BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT, 'admin_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS admin_audit_append_only_delete
BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT, 'admin_audit is append-only'); END;
