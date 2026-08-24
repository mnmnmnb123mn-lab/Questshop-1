-- Migration 0024 added contract_hash without a historical backfill. PostgreSQL
-- considers NULL values distinct in a normal unique index, so retain the
-- one-active-batch invariant explicitly while old NULL rows still exist.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM quest_test_batches
    WHERE state IN ('QUEUED','RUNNING') AND contract_hash IS NULL
    GROUP BY quest_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot install NULL contract-hash guard: duplicate active legacy quest test batches require manual review';
  END IF;
END $$;

CREATE UNIQUE INDEX quest_test_batches_one_active_null_contract_idx
  ON quest_test_batches(quest_id)
  WHERE state IN ('QUEUED','RUNNING') AND contract_hash IS NULL;
