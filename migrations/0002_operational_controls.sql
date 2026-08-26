CREATE TABLE customer_rate_limit_events (
  id uuid PRIMARY KEY,
  discord_user_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('BUTTON', 'TOKEN_VALIDATE', 'VOUCHER_INVALID', 'ORDER_CONFIRM')),
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX customer_rate_limit_window_idx
  ON customer_rate_limit_events(discord_user_id, operation, created_at DESC);

CREATE TABLE circuit_breakers (
  breaker_key text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('CLOSED', 'OPEN', 'HALF_OPEN')),
  reason text,
  failure_count integer NOT NULL DEFAULT 0,
  opened_at timestamptz,
  next_probe_at timestamptz,
  state_version bigint NOT NULL DEFAULT 1,
  trace_id uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO circuit_breakers(breaker_key,state) VALUES ('TRUEMONEY_DIRECT','CLOSED')
ON CONFLICT (breaker_key) DO NOTHING;
