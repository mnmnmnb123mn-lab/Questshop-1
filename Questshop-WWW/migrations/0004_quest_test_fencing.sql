ALTER TABLE quest_test_runs
  ADD COLUMN lease_owner uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN fencing_token bigint NOT NULL DEFAULT 0,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT transaction_timestamp();

CREATE INDEX quest_test_runs_queue_idx
  ON quest_test_runs(state, created_at) WHERE state IN ('TEST_QUEUED', 'RETEST_REQUIRED');
CREATE INDEX quest_test_runs_lease_idx
  ON quest_test_runs(lease_expires_at) WHERE state = 'TESTING';

CREATE TABLE quest_test_mutations (
  id uuid PRIMARY KEY,
  test_run_id uuid NOT NULL REFERENCES quest_test_runs(id),
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  mutation_kind text NOT NULL CHECK (mutation_kind IN ('ENROLL', 'VIDEO_PROGRESS', 'HEARTBEAT')),
  status text NOT NULL CHECK (status IN (
    'PREPARED', 'IN_FLIGHT', 'ACCEPTED', 'UNCERTAIN', 'VERIFIED', 'FAILED'
  )),
  baseline_progress numeric(14,3),
  target_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id uuid NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  attempted_at timestamptz,
  verified_at timestamptz,
  UNIQUE (test_run_id, sequence_number)
);

