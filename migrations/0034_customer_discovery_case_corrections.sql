-- Cases created while 0033 was introduced have no Monitor-search batch.  They
-- are historical checkout evidence, not proof that a Monitor could not see
-- the Quest.  Keep that distinction durable so the backoffice never reports a
-- search result that did not happen.
ALTER TABLE customer_quest_discovery_cases
  DROP CONSTRAINT customer_quest_discovery_cases_verification_state_check;

ALTER TABLE customer_quest_discovery_cases
  ADD CONSTRAINT customer_quest_discovery_cases_verification_state_check CHECK (verification_state IN (
    'NOT_CHECKED','CHECK_QUEUED','CHECKING','NOT_FOUND','CHECK_INCOMPLETE',
    'FOUND_NOT_TESTABLE','TESTING','TEST_FAILED','PASSED'
  ));

UPDATE customer_quest_discovery_cases
SET verification_state='NOT_CHECKED',
    last_result=last_result || jsonb_build_object('historical', true),
    state_version=state_version+1,
    updated_at=clock_timestamp()
WHERE verification_state='NOT_FOUND'
  AND current_search_batch_id IS NULL;

-- A generic Monitor-discovery batch and a customer Case batch have different
-- account scopes.  They may coexist, but each scope still has one active
-- batch, preventing duplicate clicks or workers from creating a second one.
DROP INDEX quest_test_batches_one_active_contract_idx;
CREATE UNIQUE INDEX quest_test_batches_one_active_scope_idx
  ON quest_test_batches(quest_id, contract_hash, COALESCE(customer_discovery_case_id,
    '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE state IN ('QUEUED','RUNNING');
