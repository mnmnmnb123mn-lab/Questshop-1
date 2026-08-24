-- Outbox and DLQ have independent state machines.  Keep a monotonic version
-- in addition to the delivery lease/fencing token so stale transitions are
-- rejected even when the same holder is reused after recovery.
ALTER TABLE outbox_events
  ADD COLUMN state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0);

ALTER TABLE dead_letter_items
  ADD COLUMN state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0);

CREATE INDEX outbox_state_version_idx ON outbox_events(id, state_version);
CREATE INDEX dead_letter_state_version_idx ON dead_letter_items(id, state_version);
