-- Questshop exposes two durable customer-facing Quest price categories.  Keep
-- older rules as immutable order evidence, but retire them from resolution.
UPDATE price_rules
SET enabled = false,
    state_version = state_version + 1
WHERE enabled = true;

INSERT INTO price_rules(
  id, rule_type, task_type, amount_cents, priority, enabled,
  starts_at, ends_at, config_version, actor_id, trace_id
)
VALUES
  (gen_random_uuid(), 'TYPE', 'PLAY_ON_DESKTOP', 500, 0, true, NULL, NULL, 1, 'SYSTEM_MIGRATION', gen_random_uuid()),
  (gen_random_uuid(), 'TYPE', 'PLAY_ON_DESKTOP_V2', 500, 0, true, NULL, NULL, 1, 'SYSTEM_MIGRATION', gen_random_uuid()),
  (gen_random_uuid(), 'TYPE', 'WATCH_VIDEO', 500, 0, true, NULL, NULL, 1, 'SYSTEM_MIGRATION', gen_random_uuid()),
  (gen_random_uuid(), 'TYPE', 'WATCH_VIDEO_ON_MOBILE', 500, 0, true, NULL, NULL, 1, 'SYSTEM_MIGRATION', gen_random_uuid());

CREATE UNIQUE INDEX price_rules_active_type_idx
  ON price_rules(task_type)
  WHERE enabled = true AND rule_type = 'TYPE';

-- New promotions are manually controlled: no campaign name or calendar is
-- exposed to admins or customers. Historical scheduled versions remain intact.
ALTER TABLE promotions
  ADD COLUMN manual_controlled boolean NOT NULL DEFAULT false;

ALTER TABLE promotions
  ALTER COLUMN starts_at DROP NOT NULL,
  ALTER COLUMN ends_at DROP NOT NULL;

DO $$
DECLARE constraint_name text;
BEGIN
  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  WHERE c.conrelid = 'promotions'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%ends_at > starts_at%'
  LIMIT 1;
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE promotions DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE promotions
  ADD CONSTRAINT promotions_manual_schedule_check CHECK (
    (manual_controlled = true AND starts_at IS NULL AND ends_at IS NULL)
    OR (manual_controlled = false AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at)
  );

WITH source AS (
  SELECT * FROM promotions
  WHERE state = 'ACTIVE' AND manual_controlled = false
    AND starts_at <= clock_timestamp() AND ends_at > clock_timestamp()
  ORDER BY version DESC
  LIMIT 1
), inserted AS (
  INSERT INTO promotions(
    id, version, name, state, starts_at, ends_at, manual_controlled,
    max_uses_per_user, max_bonus_per_day_cents, actor_id, trace_id
  )
  SELECT gen_random_uuid(), (SELECT COALESCE(max(version), 0) + 1 FROM promotions),
    'โบนัสเติมเงิน รุ่นย้ายข้อมูล', 'ACTIVE', NULL, NULL, true,
    max_uses_per_user, max_bonus_per_day_cents, 'SYSTEM_MIGRATION', gen_random_uuid()
  FROM source
  RETURNING id
)
INSERT INTO promotion_tiers(id, promotion_id, minimum_amount_cents, basis_points)
SELECT gen_random_uuid(), inserted.id, tier.minimum_amount_cents, tier.basis_points
FROM source
JOIN promotion_tiers tier ON tier.promotion_id = source.id
CROSS JOIN inserted;

UPDATE promotions
SET state = 'DISABLED', state_version = state_version + 1
WHERE state = 'ACTIVE' AND manual_controlled = false;

-- Manual user blocking is retired. Daily top-up protection remains as its own
-- system-owned record, so it cannot affect Quest orders.
CREATE TABLE topup_daily_locks (
  discord_user_id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

INSERT INTO topup_daily_locks(discord_user_id, expires_at, trace_id)
SELECT discord_user_id, expires_at, trace_id
FROM blocklist_entries
WHERE block_type = 'TOPUP_BLOCKED'
  AND reason = 'DAILY_TOPUP_LIMIT'
  AND revoked_at IS NULL
  AND expires_at > clock_timestamp()
ON CONFLICT (discord_user_id) DO UPDATE
SET expires_at = GREATEST(topup_daily_locks.expires_at, EXCLUDED.expires_at),
    updated_at = clock_timestamp();

UPDATE blocklist_entries
SET revoked_at = clock_timestamp(),
    revoked_by = 'SYSTEM_MIGRATION'
WHERE revoked_at IS NULL;

-- Normal operation is on by default. These gates remain internal incident
-- brakes, so known critical closures are deliberately preserved.
ALTER TABLE feature_gates ALTER COLUMN enabled SET DEFAULT true;
ALTER TABLE feature_gates ALTER COLUMN reason SET DEFAULT 'enabled automatically';

UPDATE feature_gates
SET enabled = true,
    reason = 'enabled automatically',
    actor_type = 'SYSTEM',
    actor_id = 'migration',
    version = version + 1,
    updated_at = clock_timestamp()
WHERE enabled = false
  AND reason NOT IN ('TRUEMONEY_SCHEMA_CIRCUIT_OPEN', 'RUNNER_VERSION_INCOMPATIBLE', 'FINANCIAL_INVARIANT');
