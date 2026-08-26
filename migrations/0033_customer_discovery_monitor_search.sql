-- Customer-sourced Quest records are evidence per checkout.  A case groups
-- those sightings by Quest so the backoffice has one durable message and one
-- active verification workflow per Quest.
CREATE TABLE customer_quest_discovery_cases (
  id uuid PRIMARY KEY,
  quest_id text NOT NULL UNIQUE REFERENCES quests(quest_id),
  first_discovery_id uuid REFERENCES customer_quest_discoveries(id) ON DELETE SET NULL,
  latest_discovery_id uuid REFERENCES customer_quest_discoveries(id) ON DELETE SET NULL,
  first_discord_user_id text,
  latest_discord_user_id text,
  first_account_id text,
  latest_account_id text,
  first_account_username text,
  latest_account_username text,
  latest_account_avatar_url text,
  sighting_count integer NOT NULL DEFAULT 1 CHECK (sighting_count > 0),
  verification_state text NOT NULL DEFAULT 'CHECK_QUEUED' CHECK (verification_state IN (
    'CHECK_QUEUED','CHECKING','NOT_FOUND','CHECK_INCOMPLETE','FOUND_NOT_TESTABLE','TESTING','TEST_FAILED','PASSED'
  )),
  announcement_state text NOT NULL DEFAULT 'NOT_ANNOUNCED' CHECK (announcement_state IN (
    'NOT_ANNOUNCED','QUEUED','ANNOUNCED'
  )),
  state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0),
  current_search_batch_id uuid,
  current_test_batch_id uuid,
  last_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE customer_quest_monitor_search_batches (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES customer_quest_discovery_cases(id) ON DELETE CASCADE,
  cycle_number integer NOT NULL CHECK (cycle_number > 0),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','RUNNING','FOUND','NOT_FOUND','INCOMPLETE','NO_MONITORS')),
  state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0),
  trace_id uuid NOT NULL,
  requested_by text NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz,
  UNIQUE(case_id, cycle_number)
);
CREATE UNIQUE INDEX customer_quest_monitor_search_one_active_idx
  ON customer_quest_monitor_search_batches(case_id) WHERE state IN ('QUEUED','RUNNING');

CREATE TABLE customer_quest_monitor_search_checks (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES customer_quest_monitor_search_batches(id) ON DELETE CASCADE,
  monitor_id uuid NOT NULL REFERENCES monitor_accounts(id),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','LEASED','VISIBLE','VISIBLE_COMPLETED','NOT_VISIBLE','FAILED')),
  state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner uuid,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 1 CHECK (fencing_token > 0),
  error_class text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE(batch_id, monitor_id)
);
CREATE INDEX customer_quest_monitor_search_checks_pending_idx
  ON customer_quest_monitor_search_checks(state, created_at);

ALTER TABLE quest_test_batches
  ADD COLUMN customer_discovery_case_id uuid REFERENCES customer_quest_discovery_cases(id) ON DELETE SET NULL;
CREATE INDEX quest_test_batches_customer_case_idx ON quest_test_batches(customer_discovery_case_id, created_at DESC)
  WHERE customer_discovery_case_id IS NOT NULL;

-- Historical discoveries remain evidence and are intentionally not scheduled
-- for external Monitor calls by this migration.
INSERT INTO customer_quest_discovery_cases(
  id,quest_id,first_discovery_id,latest_discovery_id,first_discord_user_id,latest_discord_user_id,
  first_account_id,latest_account_id,first_account_username,latest_account_username,
  latest_account_avatar_url,sighting_count,verification_state,announcement_state,trace_id
)
SELECT gen_random_uuid(), d.quest_id,
  (array_agg(d.id ORDER BY d.created_at,d.id))[1],
  (array_agg(d.id ORDER BY d.created_at DESC,d.id DESC))[1],
  (array_agg(d.discord_user_id ORDER BY d.created_at,d.id))[1],
  (array_agg(d.discord_user_id ORDER BY d.created_at DESC,d.id DESC))[1],
  (array_agg(d.account_id ORDER BY d.created_at,d.id))[1],
  (array_agg(d.account_id ORDER BY d.created_at DESC,d.id DESC))[1],
  (array_agg(d.account_username ORDER BY d.created_at,d.id))[1],
  (array_agg(d.account_username ORDER BY d.created_at DESC,d.id DESC))[1],
  (array_agg(d.account_avatar_url ORDER BY d.created_at DESC,d.id DESC))[1],
  count(*)::integer,
  'NOT_FOUND',
  CASE WHEN q.announcement_state='ANNOUNCED' THEN 'ANNOUNCED' ELSE 'NOT_ANNOUNCED' END,
  (array_agg(d.trace_id ORDER BY d.created_at DESC,d.id DESC))[1]
FROM customer_quest_discoveries d JOIN quests q ON q.quest_id=d.quest_id
GROUP BY d.quest_id,q.announcement_state
ON CONFLICT(quest_id) DO NOTHING;
