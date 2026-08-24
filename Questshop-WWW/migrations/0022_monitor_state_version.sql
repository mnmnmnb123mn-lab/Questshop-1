ALTER TABLE monitor_accounts
  ADD COLUMN state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0);
