ALTER TABLE quests
  ADD COLUMN current_contract_hash text;

ALTER TABLE quest_metadata_revisions
  ADD COLUMN contract_hash text,
  ADD COLUMN contract_complete boolean NOT NULL DEFAULT false;

ALTER TABLE quest_test_batches
  ADD COLUMN contract_hash text;

ALTER TABLE quest_test_runs
  ADD COLUMN contract_hash text,
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  ADD COLUMN deadline_at timestamptz;

ALTER TABLE quest_test_mutations
  ADD COLUMN parent_mutation_id uuid REFERENCES quest_test_mutations(id);

ALTER TABLE checkout_quest_options
  ADD COLUMN contract_hash text;

ALTER TABLE order_items
  ADD COLUMN contract_hash text;

ALTER TABLE runner_jobs
  ADD COLUMN contract_hash text;

ALTER TABLE quests
  ADD COLUMN public_test_gate_override_contract_hash text;

-- A changed execution contract needs a fresh batch even while an older
-- contract's worker is draining.  The earlier one-active-batch-per-Quest
-- index would otherwise block the retest and leave the new contract closed.
DROP INDEX quest_test_batches_one_active_idx;
CREATE UNIQUE INDEX quest_test_batches_one_active_contract_idx
  ON quest_test_batches(quest_id, contract_hash)
  WHERE state IN ('QUEUED', 'RUNNING');

CREATE INDEX quest_test_runs_due_idx
  ON quest_test_runs(state, available_at, deadline_at)
  WHERE state = 'TEST_QUEUED';

CREATE INDEX quest_test_runs_contract_pass_idx
  ON quest_test_runs(quest_id, contract_hash)
  WHERE state = 'TEST_PASSED';
