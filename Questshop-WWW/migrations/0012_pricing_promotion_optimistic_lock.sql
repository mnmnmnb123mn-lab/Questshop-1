-- Price and promotion terms are immutable snapshots, but their availability is
-- mutable configuration.  These versions prevent two administrators from
-- silently enabling/disabling a stale configuration view.
ALTER TABLE price_rules
  ADD COLUMN IF NOT EXISTS state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0);

ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0);

CREATE INDEX IF NOT EXISTS price_rules_state_version_idx ON price_rules(id, state_version);
CREATE INDEX IF NOT EXISTS promotions_state_version_idx ON promotions(id, state_version);
