-- Sessions are the durable bridge between Discord interactions.  Persist the
-- ingress trace so a later button/modal interaction cannot break the
-- correlation chain for an order, reservation, runner and outbox event.
ALTER TABLE interaction_sessions ADD COLUMN trace_id uuid;

UPDATE interaction_sessions
SET trace_id = gen_random_uuid()
WHERE trace_id IS NULL;

ALTER TABLE interaction_sessions ALTER COLUMN trace_id SET NOT NULL;

CREATE INDEX interaction_sessions_trace_idx ON interaction_sessions(trace_id, created_at DESC);
