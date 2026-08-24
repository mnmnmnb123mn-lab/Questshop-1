-- A public Quest sale is gated by a successful Monitor test.  Customer
-- checkout can still admit an account-specific Quest when it was discovered
-- from that customer's authenticated session.
ALTER TABLE quests
  ADD COLUMN public_test_gate_override boolean NOT NULL DEFAULT false,
  ADD COLUMN public_test_gate_override_by text,
  ADD COLUMN public_test_gate_override_at timestamptz,
  ADD COLUMN public_test_gate_override_reason text;

ALTER TABLE checkout_quest_options
  ADD COLUMN admission_scope text NOT NULL DEFAULT 'PUBLIC'
    CHECK (admission_scope IN ('PUBLIC', 'CUSTOMER_ACCOUNT'));

ALTER TABLE order_items
  ADD COLUMN admission_scope text NOT NULL DEFAULT 'PUBLIC'
    CHECK (admission_scope IN ('PUBLIC', 'CUSTOMER_ACCOUNT'));

CREATE TABLE quest_test_batches (
  id uuid PRIMARY KEY,
  quest_id text NOT NULL REFERENCES quests(quest_id),
  state text NOT NULL CHECK (state IN ('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'OVERRIDDEN')),
  state_version bigint NOT NULL DEFAULT 1,
  monitor_order uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  current_monitor_index integer NOT NULL DEFAULT 0 CHECK (current_monitor_index >= 0),
  max_attempts_per_monitor smallint NOT NULL DEFAULT 3 CHECK (max_attempts_per_monitor = 3),
  latest_error jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id uuid NOT NULL,
  requested_by text NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX quest_test_batches_one_active_idx
  ON quest_test_batches(quest_id) WHERE state IN ('QUEUED', 'RUNNING');
CREATE INDEX quest_test_batches_state_idx ON quest_test_batches(state, created_at);

ALTER TABLE quest_test_runs
  ADD COLUMN batch_id uuid REFERENCES quest_test_batches(id),
  ADD COLUMN target_monitor_id uuid REFERENCES monitor_accounts(id),
  ADD COLUMN attempt_in_monitor smallint CHECK (attempt_in_monitor IS NULL OR attempt_in_monitor BETWEEN 1 AND 3);

CREATE INDEX quest_test_runs_batch_idx ON quest_test_runs(batch_id, target_monitor_id, attempt_in_monitor);

CREATE TABLE quest_test_failure_alerts (
  id uuid PRIMARY KEY,
  quest_id text NOT NULL REFERENCES quests(quest_id),
  batch_id uuid NOT NULL REFERENCES quest_test_batches(id),
  state text NOT NULL CHECK (state IN ('OPEN', 'RETRYING', 'OVERRIDDEN', 'RESOLVED')),
  state_version bigint NOT NULL DEFAULT 1,
  last_error jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE UNIQUE INDEX quest_test_failure_alerts_open_quest_idx
  ON quest_test_failure_alerts(quest_id) WHERE state IN ('OPEN', 'RETRYING');
CREATE INDEX quest_test_failure_alerts_batch_idx ON quest_test_failure_alerts(batch_id);

CREATE TABLE customer_quest_discoveries (
  id uuid PRIMARY KEY,
  checkout_session_id uuid NOT NULL REFERENCES interaction_sessions(id) ON DELETE CASCADE,
  quest_id text NOT NULL REFERENCES quests(quest_id),
  metadata_revision bigint NOT NULL,
  discord_user_id text NOT NULL,
  account_id text NOT NULL,
  account_username text,
  account_avatar_url text,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (checkout_session_id, quest_id)
);

CREATE INDEX customer_quest_discoveries_quest_idx
  ON customer_quest_discoveries(quest_id, created_at DESC);
