-- Every Monitor is intentionally capable of both discovery and background
-- testing.  Health records are operational metadata only; credentials remain
-- in monitor_credentials and are never copied into these columns.
UPDATE monitor_accounts
SET capabilities = ARRAY['SCAN', 'TEST']::text[];

ALTER TABLE monitor_accounts
  ADD COLUMN health_state text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (health_state IN ('UNKNOWN', 'READY', 'DEGRADED', 'INVALID')),
  ADD COLUMN last_health_checked_at timestamptz,
  ADD COLUMN last_health_error_code text,
  ADD COLUMN last_health_quest_count integer,
  ADD COLUMN last_health_account_id text;

CREATE INDEX monitor_accounts_health_idx
  ON monitor_accounts(health_state, state, last_health_checked_at DESC);
