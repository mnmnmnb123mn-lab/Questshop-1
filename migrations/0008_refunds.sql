CREATE TABLE refunds (
  id uuid PRIMARY KEY,
  order_item_id uuid NOT NULL REFERENCES order_items(id),
  discord_user_id text NOT NULL REFERENCES wallets(discord_user_id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL,
  actor_id text NOT NULL,
  trace_id uuid NOT NULL,
  wallet_transaction_id uuid NOT NULL UNIQUE REFERENCES wallet_transactions(id),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (order_item_id)
);

CREATE INDEX refunds_user_created_idx ON refunds(discord_user_id, created_at DESC);

