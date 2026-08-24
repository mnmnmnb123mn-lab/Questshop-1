-- Customer-discovered Quest records are operational evidence, not temporary
-- checkout data.  Retention may delete the checkout session after seven days,
-- but the backoffice decision and audit trail must remain available.
ALTER TABLE customer_quest_discoveries
  DROP CONSTRAINT IF EXISTS customer_quest_discoveries_checkout_session_id_fkey;

ALTER TABLE customer_quest_discoveries
  ALTER COLUMN checkout_session_id DROP NOT NULL,
  ADD CONSTRAINT customer_quest_discoveries_checkout_session_id_fkey
    FOREIGN KEY (checkout_session_id) REFERENCES interaction_sessions(id) ON DELETE SET NULL,
  ADD COLUMN state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING','TEST_REQUESTED','PUBLISHED')),
  ADD COLUMN state_version bigint NOT NULL DEFAULT 1,
  ADD COLUMN test_batch_id uuid REFERENCES quest_test_batches(id) ON DELETE SET NULL,
  ADD COLUMN decision_by text,
  ADD COLUMN decision_reason text,
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT transaction_timestamp();

CREATE INDEX customer_quest_discoveries_pending_idx
  ON customer_quest_discoveries(state, created_at)
  WHERE state = 'PENDING';
