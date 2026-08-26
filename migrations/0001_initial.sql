CREATE TABLE IF NOT EXISTS runtime_leases (
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  lease_owner uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  PRIMARY KEY (resource_type, resource_id)
);

CREATE TABLE config_versions (
  id uuid PRIMARY KEY,
  version bigint NOT NULL UNIQUE CHECK (version > 0),
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE feature_gates (
  gate text PRIMARY KEY CHECK (gate IN (
    'STORE_OPEN', 'CUSTOMER_INTERACTIONS_ENABLED', 'TOPUP_ACCEPTING',
    'AUTO_CREDIT_ENABLED', 'QUEST_SCANNER_ENABLED',
    'QUEST_BACKGROUND_TESTING_ENABLED', 'QUEST_ANNOUNCEMENT_ENABLED',
    'ORDER_ACCEPTING', 'RUNNER_DISPATCH_ENABLED', 'NOTIFICATIONS_ENABLED',
    'RETENTION_JOBS_ENABLED'
  )),
  enabled boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  reason text NOT NULL DEFAULT 'initially disabled',
  actor_type text NOT NULL DEFAULT 'SYSTEM',
  actor_id text NOT NULL DEFAULT 'migration',
  trace_id uuid,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

INSERT INTO feature_gates(gate) VALUES
  ('STORE_OPEN'), ('CUSTOMER_INTERACTIONS_ENABLED'), ('TOPUP_ACCEPTING'),
  ('AUTO_CREDIT_ENABLED'), ('QUEST_SCANNER_ENABLED'),
  ('QUEST_BACKGROUND_TESTING_ENABLED'), ('QUEST_ANNOUNCEMENT_ENABLED'),
  ('ORDER_ACCEPTING'), ('RUNNER_DISPATCH_ENABLED'), ('NOTIFICATIONS_ENABLED'),
  ('RETENTION_JOBS_ENABLED')
ON CONFLICT (gate) DO NOTHING;

CREATE TABLE surfaces (
  surface_key text PRIMARY KEY CHECK (surface_key IN (
    'QUEST_AUTO', 'QUEST_NEW', 'QUEST_HISTORY', 'ADMIN_PANEL',
    'LOG_PAYMENTS', 'LOG_QUEST_OPERATIONS', 'LOG_ADMIN', 'LOG_SYSTEM'
  )),
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  message_id text,
  renderer_version integer NOT NULL DEFAULT 1,
  expected_permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'DRIFTED', 'RECONCILING', 'DISABLED')), -- NOSONAR: persisted state literals are the schema contract.
  state_version bigint NOT NULL DEFAULT 1,
  last_validated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE interaction_sessions (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  message_id text,
  operation text NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'CONFIRMED', 'EXPIRED', 'CANCELLED', 'TERMINAL')), -- NOSONAR: persisted state literals are the schema contract.
  state_version bigint NOT NULL DEFAULT 1,
  config_version bigint NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX interaction_sessions_expiry_idx ON interaction_sessions(state, expires_at);
CREATE INDEX interaction_sessions_actor_idx ON interaction_sessions(actor_id, created_at DESC);

CREATE TABLE checkout_credentials (
  session_id uuid PRIMARY KEY REFERENCES interaction_sessions(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  key_version integer NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE checkout_quest_options (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES interaction_sessions(id) ON DELETE CASCADE,
  line_id text NOT NULL,
  quest_id text NOT NULL,
  quest_name text NOT NULL,
  task_type text NOT NULL,
  price_cents bigint NOT NULL CHECK (price_cents > 0),
  price_rule_id uuid NOT NULL,
  metadata_revision bigint NOT NULL,
  deadline_at timestamptz NOT NULL,
  selected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (session_id, line_id),
  UNIQUE (session_id, quest_id)
);

CREATE INDEX checkout_options_page_idx ON checkout_quest_options(session_id, created_at, id);

CREATE TABLE idempotency_keys (
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  actor_id text NOT NULL,
  result_type text,
  result_id text,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  expires_at timestamptz,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE TABLE state_transitions (
  id uuid PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  from_state text,
  to_state text NOT NULL,
  state_version bigint NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  trace_id uuid NOT NULL,
  causation_id uuid,
  reason_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX state_transitions_aggregate_idx
  ON state_transitions(aggregate_type, aggregate_id, state_version);
CREATE INDEX state_transitions_trace_idx ON state_transitions(trace_id, created_at);

CREATE TABLE wallets (
  discord_user_id text PRIMARY KEY,
  available_cents bigint NOT NULL DEFAULT 0 CHECK (available_cents >= 0),
  reserved_cents bigint NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
  state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE wallet_transactions (
  id uuid PRIMARY KEY,
  discord_user_id text NOT NULL REFERENCES wallets(discord_user_id),
  transaction_group_id uuid NOT NULL,
  transaction_type text NOT NULL CHECK (transaction_type IN (
    'TOPUP_CREDIT', 'TOPUP_REVERSAL', 'RESERVE', 'CAPTURE', 'RELEASE',
    'ADMIN_CREDIT', 'ADMIN_DEBIT', 'REFUND_CREDIT', 'OPENING_CHECKPOINT'
  )),
  delta_available_cents bigint NOT NULL,
  delta_reserved_cents bigint NOT NULL,
  available_before_cents bigint NOT NULL CHECK (available_before_cents >= 0),
  available_after_cents bigint NOT NULL CHECK (available_after_cents >= 0),
  reserved_before_cents bigint NOT NULL CHECK (reserved_before_cents >= 0),
  reserved_after_cents bigint NOT NULL CHECK (reserved_after_cents >= 0),
  principal_cents bigint,
  bonus_cents bigint,
  reference_type text NOT NULL,
  reference_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_hash text,
  entry_hash text NOT NULL,
  trace_id uuid NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (available_after_cents = available_before_cents + delta_available_cents),
  CHECK (reserved_after_cents = reserved_before_cents + delta_reserved_cents),
  CHECK (principal_cents IS NULL OR principal_cents >= 0),
  CHECK (bonus_cents IS NULL OR bonus_cents >= 0)
);

CREATE INDEX wallet_transactions_user_idx
  ON wallet_transactions(discord_user_id, created_at DESC, id);
CREATE INDEX wallet_transactions_reference_idx
  ON wallet_transactions(reference_type, reference_id);

CREATE TABLE wallet_checkpoints (
  id uuid PRIMARY KEY,
  discord_user_id text NOT NULL REFERENCES wallets(discord_user_id),
  through_transaction_id uuid NOT NULL,
  available_cents bigint NOT NULL CHECK (available_cents >= 0),
  reserved_cents bigint NOT NULL CHECK (reserved_cents >= 0),
  chain_hash text NOT NULL,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE receiver_versions (
  id uuid PRIMARY KEY,
  version bigint NOT NULL UNIQUE,
  encrypted_phone bytea NOT NULL,
  encryption_key_version integer NOT NULL,
  nonce bytea NOT NULL,
  auth_tag bytea NOT NULL,
  phone_last4 text NOT NULL CHECK (phone_last4 ~ '^\d{4}$'),
  state text NOT NULL CHECK (state IN ('ACTIVE', 'INACTIVE')),
  activated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  deactivated_at timestamptz,
  actor_id text NOT NULL,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE UNIQUE INDEX receiver_versions_one_active_idx
  ON receiver_versions((state)) WHERE state = 'ACTIVE';

CREATE TABLE promotions (
  id uuid PRIMARY KEY,
  version bigint NOT NULL UNIQUE,
  name text NOT NULL,
  state text NOT NULL CHECK (state IN ('DRAFT', 'ACTIVE', 'DISABLED', 'EXPIRED')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  max_uses_per_user integer CHECK (max_uses_per_user IS NULL OR max_uses_per_user > 0),
  max_bonus_per_day_cents bigint CHECK (max_bonus_per_day_cents IS NULL OR max_bonus_per_day_cents >= 0),
  actor_id text NOT NULL,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE promotion_tiers (
  id uuid PRIMARY KEY,
  promotion_id uuid NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  minimum_amount_cents bigint NOT NULL CHECK (minimum_amount_cents >= 0),
  basis_points integer NOT NULL CHECK (basis_points >= 0 AND basis_points <= 10000),
  UNIQUE (promotion_id, minimum_amount_cents)
);

CREATE TABLE promotion_usages (
  id uuid PRIMARY KEY,
  promotion_id uuid NOT NULL REFERENCES promotions(id),
  discord_user_id text NOT NULL,
  topup_id uuid NOT NULL UNIQUE,
  bangkok_day date NOT NULL,
  principal_cents bigint NOT NULL CHECK (principal_cents >= 0),
  bonus_cents bigint NOT NULL CHECK (bonus_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX promotion_usages_limit_idx
  ON promotion_usages(promotion_id, discord_user_id, bangkok_day);

CREATE TABLE topups (
  id uuid PRIMARY KEY,
  discord_user_id text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'RECEIVED', 'VALIDATING', 'PAYMENT_QUEUED', 'PROCESSING', 'REDEEMED', -- NOSONAR: persisted payment-state contract.
    'CREDITED', 'AMBIGUOUS', 'MANUAL_REVIEW', 'INVALID', 'EXPIRED', -- NOSONAR: persisted payment-state contract.
    'ALREADY_REDEEMED', 'RETRY_WAIT', 'FAILED', 'REJECTED', 'REVERSED' -- NOSONAR: persisted payment-state contract.
  )),
  state_version bigint NOT NULL DEFAULT 1,
  voucher_hmac_version integer NOT NULL,
  voucher_hmac bytea NOT NULL,
  receiver_version_id uuid NOT NULL REFERENCES receiver_versions(id),
  receiver_phone_last4 text NOT NULL,
  promotion_id uuid REFERENCES promotions(id),
  provider_transaction_id text,
  amount_cents bigint CHECK (amount_cents IS NULL OR amount_cents >= 0),
  bonus_cents bigint CHECK (bonus_cents IS NULL OR bonus_cents >= 0),
  currency text,
  sender_name text,
  sender_phone text,
  failure_code text,
  warning_code text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  lease_owner uuid,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  prelaunch boolean NOT NULL DEFAULT false,
  trace_id uuid NOT NULL,
  redeemed_at timestamptz,
  credited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (voucher_hmac_version, voucher_hmac)
);

CREATE UNIQUE INDEX topups_provider_transaction_idx
  ON topups(provider_transaction_id) WHERE provider_transaction_id IS NOT NULL;
CREATE INDEX topups_queue_idx ON topups(status, available_at, updated_at);
CREATE INDEX topups_lease_idx ON topups(lease_expires_at) WHERE status = 'PROCESSING';
CREATE INDEX topups_user_day_idx ON topups(discord_user_id, created_at DESC);

CREATE TABLE topup_sensitive_payloads (
  topup_id uuid PRIMARY KEY REFERENCES topups(id) ON DELETE CASCADE,
  key_version integer NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  log_delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE payment_attempts (
  id uuid PRIMARY KEY,
  topup_id uuid NOT NULL REFERENCES topups(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  parent_attempt_id uuid REFERENCES payment_attempts(id),
  dispatch_state text NOT NULL CHECK (dispatch_state IN (
    'INTENT_RECORDED', 'NOT_SENT', 'POSSIBLY_SENT', 'RESPONSE_RECEIVED', -- NOSONAR: persisted payment-attempt contract.
    'VERIFIED', 'FAILED', 'AMBIGUOUS' -- NOSONAR: persisted payment-attempt contract.
  )),
  provider_status_code text,
  provider_http_status integer,
  provider_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_class text,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  possibly_sent_at timestamptz,
  completed_at timestamptz,
  trace_id uuid NOT NULL,
  UNIQUE (topup_id, attempt_number)
);

CREATE TABLE quests (
  quest_id text PRIMARY KEY,
  analysis_state text NOT NULL CHECK (analysis_state IN (
    'DETECTED', 'METADATA_RETRY', 'ANALYZED', 'SUPPORTED', 'UNSUPPORTED',
    'MANUAL_REVIEW', 'EXPIRED'
  )),
  analysis_version bigint NOT NULL DEFAULT 1,
  announcement_state text NOT NULL DEFAULT 'NOT_ANNOUNCED'
    CHECK (announcement_state IN ('NOT_ANNOUNCED', 'ANNOUNCED')),
  announcement_version bigint NOT NULL DEFAULT 1,
  sale_state text NOT NULL DEFAULT 'CLOSED'
    CHECK (sale_state IN ('CLOSED', 'OPEN', 'PAUSED', 'EXPIRED')),
  sale_version bigint NOT NULL DEFAULT 1,
  name text,
  task_type text,
  task_target numeric(14,3),
  url text,
  artwork_url text,
  orbs integer CHECK (orbs IS NULL OR orbs >= 0),
  starts_at timestamptz,
  expires_at timestamptz,
  executor_id text,
  engine_version text,
  executor_version text,
  contract_version text,
  current_metadata_revision bigint NOT NULL DEFAULT 0,
  first_analysis_at timestamptz,
  detected_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX quests_sale_idx ON quests(sale_state, expires_at);
CREATE INDEX quests_analysis_idx ON quests(analysis_state, updated_at);

CREATE TABLE quest_metadata_revisions (
  id uuid PRIMARY KEY,
  quest_id text NOT NULL REFERENCES quests(quest_id),
  revision bigint NOT NULL,
  normalized jsonb NOT NULL,
  redacted_raw jsonb NOT NULL,
  source text NOT NULL CHECK (source IN ('MONITOR', 'CUSTOMER_CHECKOUT', 'ADMIN')), -- NOSONAR: persisted source contract.
  core_complete boolean NOT NULL,
  schema_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (quest_id, revision)
);

CREATE TABLE price_rules (
  id uuid PRIMARY KEY,
  rule_type text NOT NULL CHECK (rule_type IN ('TEMPORARY', 'QUEST', 'TYPE', 'DEFAULT')), -- NOSONAR: persisted rule-scope contract.
  quest_id text REFERENCES quests(quest_id),
  task_type text,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  priority integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  config_version bigint NOT NULL,
  actor_id text NOT NULL,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  CHECK (
    (rule_type = 'QUEST' AND quest_id IS NOT NULL) OR
    (rule_type = 'TYPE' AND task_type IS NOT NULL) OR
    (rule_type IN ('TEMPORARY', 'DEFAULT'))
  )
);

CREATE INDEX price_rules_resolve_idx
  ON price_rules(enabled, rule_type, quest_id, task_type, starts_at, ends_at, priority DESC);

CREATE TABLE monitor_accounts (
  id uuid PRIMARY KEY,
  account_id text NOT NULL UNIQUE,
  username text,
  capabilities text[] NOT NULL DEFAULT ARRAY['SCAN']::text[],
  state text NOT NULL CHECK (state IN ('ACTIVE', 'COOLDOWN', 'QUARANTINED', 'DISABLED')),
  priority integer NOT NULL DEFAULT 0,
  consecutive_failures integer NOT NULL DEFAULT 0,
  cooldown_until timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (capabilities <@ ARRAY['SCAN', 'TEST']::text[])
);

CREATE TABLE monitor_credentials (
  monitor_id uuid PRIMARY KEY REFERENCES monitor_accounts(id) ON DELETE CASCADE,
  key_version integer NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE quest_test_runs (
  id uuid PRIMARY KEY,
  quest_id text NOT NULL REFERENCES quests(quest_id),
  monitor_id uuid REFERENCES monitor_accounts(id),
  state text NOT NULL CHECK (state IN (
    'TEST_QUEUED', 'TESTING', 'TEST_PASSED', 'TEST_FAILED',
    'MANUAL_REVIEW', 'RETEST_REQUIRED'
  )),
  state_version bigint NOT NULL DEFAULT 1,
  engine_version text NOT NULL,
  executor_version text NOT NULL,
  contract_version text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_class text,
  trace_id uuid NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  discord_user_id text NOT NULL,
  account_id text NOT NULL,
  account_username text,
  account_avatar_url text,
  trace_id uuid NOT NULL,
  prelaunch boolean NOT NULL DEFAULT false,
  dm_summary_attempted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz
);

CREATE TABLE order_credentials (
  order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  key_version integer NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE active_quest_accounts (
  account_id text PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  acquired_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE order_items (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  quest_id text NOT NULL REFERENCES quests(quest_id),
  quest_name text NOT NULL,
  task_type text NOT NULL,
  price_cents bigint NOT NULL CHECK (price_cents > 0),
  price_rule_id uuid NOT NULL REFERENCES price_rules(id),
  config_version bigint NOT NULL,
  metadata_revision bigint NOT NULL,
  engine_version text NOT NULL,
  executor_version text NOT NULL,
  contract_version text NOT NULL,
  runner_state_schema_version integer NOT NULL,
  state text NOT NULL CHECK (state IN (
    'SELECTED', 'RESERVED', 'QUEUED', 'LEASED', 'RUNNING', 'VERIFYING', -- NOSONAR: immutable order-item state contract.
    'WAITING_RATE_LIMIT', 'WAITING_RETRY', 'MANUAL_REVIEW', 'SETTLING', -- NOSONAR: immutable order-item state contract.
    'READY_TO_CLAIM', 'EXPIRED_RELEASED', 'EXTERNAL_COMPLETED_RELEASED', -- NOSONAR: immutable order-item state contract.
    'STOPPED_RELEASED', 'FAILED_RELEASED' -- NOSONAR: immutable order-item state contract.
  )),
  state_version bigint NOT NULL DEFAULT 1,
  progress_actual numeric(7,3) NOT NULL DEFAULT 0 CHECK (progress_actual >= 0 AND progress_actual <= 100),
  progress_bucket smallint NOT NULL DEFAULT 0 CHECK (progress_bucket IN (0, 25, 50, 75, 100)),
  claim_url text,
  deadline_at timestamptz NOT NULL,
  terminal_reason text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (order_id, sequence_number),
  UNIQUE (order_id, quest_id)
);

CREATE INDEX order_items_order_idx ON order_items(order_id, sequence_number);
CREATE INDEX order_items_state_idx ON order_items(state, deadline_at);

CREATE TABLE wallet_reservations (
  id uuid PRIMARY KEY,
  order_item_id uuid NOT NULL UNIQUE REFERENCES order_items(id),
  discord_user_id text NOT NULL REFERENCES wallets(discord_user_id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  state text NOT NULL CHECK (state IN ('RESERVED', 'CAPTURED', 'RELEASED')),
  state_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  settled_at timestamptz
);

CREATE TABLE scheduler_users (
  discord_user_id text PRIMARY KEY,
  last_dispatched_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE runner_jobs (
  id uuid PRIMARY KEY,
  order_item_id uuid NOT NULL UNIQUE REFERENCES order_items(id),
  discord_user_id text NOT NULL,
  account_id text NOT NULL,
  state text NOT NULL CHECK (state IN (
    'QUEUED', 'LEASED', 'RUNNING', 'WAITING_RATE_LIMIT', 'WAITING_RETRY',
    'VERIFYING', 'SETTLING', 'MANUAL_REVIEW', 'COMPLETED', 'FAILED'
  )),
  state_version bigint NOT NULL DEFAULT 1,
  available_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  deadline_at timestamptz NOT NULL,
  lease_owner uuid,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  attempt_count integer NOT NULL DEFAULT 0,
  engine_version text NOT NULL,
  executor_version text NOT NULL,
  contract_version text NOT NULL,
  runner_state_schema_version integer NOT NULL,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX runner_jobs_dispatch_idx
  ON runner_jobs(state, available_at, deadline_at, discord_user_id);
CREATE INDEX runner_jobs_lease_idx ON runner_jobs(lease_expires_at) WHERE state = 'LEASED';

CREATE TABLE runner_attempts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES runner_jobs(id),
  attempt_number integer NOT NULL,
  parent_attempt_id uuid REFERENCES runner_attempts(id),
  stage text NOT NULL,
  error_class text,
  error_code text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz,
  UNIQUE (job_id, attempt_number)
);

CREATE TABLE runner_mutations (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES runner_jobs(id),
  attempt_id uuid NOT NULL REFERENCES runner_attempts(id),
  sequence_number integer NOT NULL,
  mutation_kind text NOT NULL CHECK (mutation_kind IN ('ENROLL', 'VIDEO_PROGRESS', 'HEARTBEAT')),
  status text NOT NULL CHECK (status IN (
    'PREPARED', 'IN_FLIGHT', 'ACCEPTED', 'UNCERTAIN', 'VERIFIED', 'FAILED'
  )),
  baseline_progress numeric(14,3),
  target_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_hash text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_class text,
  trace_id uuid NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  attempted_at timestamptz,
  verified_at timestamptz,
  UNIQUE (job_id, sequence_number)
);

CREATE TABLE runtime_samples (
  id uuid PRIMARY KEY,
  task_type text NOT NULL,
  duration_ms bigint NOT NULL CHECK (duration_ms >= 0),
  successful boolean NOT NULL,
  order_item_id uuid REFERENCES order_items(id),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX runtime_samples_p95_idx ON runtime_samples(task_type, created_at DESC);

CREATE TABLE message_projections (
  id uuid PRIMARY KEY,
  projection_type text NOT NULL,
  aggregate_id text NOT NULL,
  surface_key text NOT NULL,
  channel_id text,
  message_id text,
  desired_version bigint NOT NULL DEFAULT 1,
  delivered_version bigint NOT NULL DEFAULT 0,
  renderer_version integer NOT NULL DEFAULT 1,
  nonce text NOT NULL CHECK (length(nonce) <= 25),
  next_allowed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'PAUSED', 'TERMINAL')),
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (projection_type, aggregate_id, surface_key)
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  topic text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  aggregate_version bigint NOT NULL,
  projection_id uuid REFERENCES message_projections(id),
  state text NOT NULL CHECK (state IN ('PENDING', 'LEASED', 'DELIVERED', 'RETRY_WAIT', 'DEAD_LETTER')),
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  lease_owner uuid,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  trace_id uuid NOT NULL,
  causation_id uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  delivered_at timestamptz,
  UNIQUE (topic, aggregate_type, aggregate_id, aggregate_version)
);

CREATE INDEX outbox_dispatch_idx ON outbox_events(state, available_at, created_at);
CREATE INDEX outbox_lease_idx ON outbox_events(lease_expires_at) WHERE state = 'LEASED';

CREATE TABLE delivery_attempts (
  id uuid PRIMARY KEY,
  outbox_id uuid NOT NULL REFERENCES outbox_events(id),
  attempt_number integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('DELIVERED', 'RETRY', 'UNKNOWN', 'FAILED')), -- NOSONAR: persisted delivery contract.
  discord_status integer,
  error_code text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (outbox_id, attempt_number)
);

CREATE TABLE dead_letter_items (
  id uuid PRIMARY KEY,
  source_type text NOT NULL,
  source_id text NOT NULL,
  category text NOT NULL CHECK (category IN ('FINANCIAL', 'AUDIT', 'NOTIFICATION', 'RUNNER', 'SYSTEM')), -- NOSONAR: persisted DLQ-category contract.
  state text NOT NULL CHECK (state IN ('DEAD_LETTER', 'PENDING', 'RESOLVED', 'DISCARDED')), -- NOSONAR: persisted DLQ-state contract.
  error_code text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  parent_trace_id uuid NOT NULL,
  replay_trace_id uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  resolved_at timestamptz,
  UNIQUE (source_type, source_id, state)
);

CREATE TABLE manual_reviews (
  id uuid PRIMARY KEY,
  subject_type text NOT NULL CHECK (subject_type IN ('TOPUP', 'ORDER_ITEM', 'QUEST', 'DLQ', 'FINANCIAL')),
  subject_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('OPEN', 'ASSIGNED', 'EVIDENCE_PENDING', 'DECISION_READY', 'RESOLVED')),
  state_version bigint NOT NULL DEFAULT 1,
  financial boolean NOT NULL DEFAULT false,
  owner_only boolean NOT NULL DEFAULT false,
  assigned_to text,
  opened_reason text NOT NULL,
  trace_id uuid NOT NULL,
  remind_at timestamptz NOT NULL DEFAULT (transaction_timestamp() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  resolved_at timestamptz
);

CREATE UNIQUE INDEX manual_reviews_open_subject_idx
  ON manual_reviews(subject_type, subject_id) WHERE state <> 'RESOLVED';
CREATE INDEX manual_reviews_reminder_idx ON manual_reviews(state, remind_at);

CREATE TABLE review_evidence (
  id uuid PRIMARY KEY,
  review_id uuid NOT NULL REFERENCES manual_reviews(id),
  evidence_type text NOT NULL,
  payload jsonb NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE review_decisions (
  id uuid PRIMARY KEY,
  review_id uuid NOT NULL REFERENCES manual_reviews(id),
  decision text NOT NULL,
  reason text NOT NULL,
  actor_id text NOT NULL,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE blocklist_entries (
  id uuid PRIMARY KEY,
  discord_user_id text NOT NULL,
  block_type text NOT NULL CHECK (block_type IN ('TOPUP_BLOCKED', 'ORDER_BLOCKED')),
  reason text NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  expires_at timestamptz,
  actor_id text NOT NULL,
  trace_id uuid NOT NULL,
  revoked_at timestamptz,
  revoked_by text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (expires_at IS NULL OR expires_at > starts_at)
);

CREATE UNIQUE INDEX blocklist_active_idx
  ON blocklist_entries(discord_user_id, block_type) WHERE revoked_at IS NULL;

CREATE TABLE admin_audit_logs (
  id uuid PRIMARY KEY,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  actor_id text NOT NULL,
  before_state jsonb,
  after_state jsonb,
  reason text NOT NULL,
  trace_id uuid NOT NULL,
  correlation_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX admin_audit_target_idx ON admin_audit_logs(target_type, target_id, created_at DESC);

CREATE TABLE incidents (
  id uuid PRIMARY KEY,
  incident_code text NOT NULL,
  scope text NOT NULL,
  state text NOT NULL CHECK (state IN ('OPEN', 'RECOVERING', 'RESOLVED')),
  severity text NOT NULL CHECK (severity IN ('WARNING', 'ERROR', 'CRITICAL')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  resolved_at timestamptz
);

CREATE UNIQUE INDEX incidents_open_scope_idx
  ON incidents(incident_code, scope) WHERE state <> 'RESOLVED';

CREATE TABLE operation_metrics (
  id uuid PRIMARY KEY,
  operation text NOT NULL,
  outcome text NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  error_class text,
  trace_id uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX operation_metrics_window_idx ON operation_metrics(operation, created_at DESC);

CREATE TABLE backup_runs (
  id uuid PRIMARY KEY,
  backup_type text NOT NULL CHECK (backup_type IN ('DAILY', 'PRE_MIGRATION')),
  state text NOT NULL CHECK (state IN ('STARTED', 'UPLOADED', 'VERIFIED', 'FAILED')),
  object_key text,
  checksum text,
  size_bytes bigint,
  schema_version integer,
  git_sha text NOT NULL,
  encryption_key_version integer NOT NULL,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz
);

CREATE TABLE restore_drills (
  id uuid PRIMARY KEY,
  backup_run_id uuid NOT NULL REFERENCES backup_runs(id),
  state text NOT NULL CHECK (state IN ('STARTED', 'RESTORED', 'VERIFIED', 'FAILED')),
  checks jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz
);

CREATE VIEW order_aggregates AS
SELECT
  o.id AS order_id,
  count(i.id) AS total_items,
  count(i.id) FILTER (WHERE i.state = 'READY_TO_CLAIM') AS captured_items,
  count(i.id) FILTER (WHERE i.state LIKE '%_RELEASED') AS released_items,
  count(i.id) FILTER (WHERE i.state = 'MANUAL_REVIEW') AS review_items,
  count(i.id) FILTER (WHERE i.state NOT IN (
    'READY_TO_CLAIM', 'EXPIRED_RELEASED', 'EXTERNAL_COMPLETED_RELEASED',
    'STOPPED_RELEASED', 'FAILED_RELEASED'
  )) AS active_items,
  CASE
    WHEN count(i.id) = 0 THEN 'EMPTY'
    WHEN count(i.id) FILTER (WHERE i.state NOT IN (
      'READY_TO_CLAIM', 'EXPIRED_RELEASED', 'EXTERNAL_COMPLETED_RELEASED',
      'STOPPED_RELEASED', 'FAILED_RELEASED'
    )) > 0 THEN 'ACTIVE'
    WHEN count(i.id) FILTER (WHERE i.state = 'READY_TO_CLAIM') = count(i.id) THEN 'COMPLETED'
    WHEN count(i.id) FILTER (WHERE i.state = 'READY_TO_CLAIM') = 0 THEN 'RELEASED'
    ELSE 'PARTIAL'
  END AS aggregate_state
FROM orders o
LEFT JOIN order_items i ON i.order_id = o.id
GROUP BY o.id;

REVOKE UPDATE, DELETE ON wallet_transactions FROM PUBLIC;
REVOKE UPDATE, DELETE ON admin_audit_logs FROM PUBLIC;
