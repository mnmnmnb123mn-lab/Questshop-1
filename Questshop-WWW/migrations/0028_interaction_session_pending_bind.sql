ALTER TABLE interaction_sessions
  DROP CONSTRAINT IF EXISTS interaction_sessions_state_check;

ALTER TABLE interaction_sessions
  ADD CONSTRAINT interaction_sessions_state_check
  CHECK (state IN ('PENDING_BIND','ACTIVE','CONFIRMED','EXPIRED','CANCELLED','TERMINAL'));
