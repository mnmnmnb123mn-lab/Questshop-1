CREATE TABLE quest_api_rate_limit_blocks (
  scope text NOT NULL CHECK (scope IN ('GLOBAL','ROUTE','ACCOUNT')),
  block_key text NOT NULL,
  blocked_until timestamptz NOT NULL,
  state_version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope, block_key)
);

CREATE INDEX quest_api_rate_limit_blocks_due_idx
  ON quest_api_rate_limit_blocks(blocked_until);
