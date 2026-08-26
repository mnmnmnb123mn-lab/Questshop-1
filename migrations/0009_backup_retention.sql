ALTER TABLE backup_runs DROP CONSTRAINT backup_runs_state_check;
ALTER TABLE backup_runs ADD CONSTRAINT backup_runs_state_check
  CHECK (state IN ('STARTED', 'UPLOADED', 'VERIFIED', 'FAILED', 'EXPIRED'));
ALTER TABLE backup_runs ADD COLUMN expired_at timestamptz;
CREATE INDEX backup_runs_retention_idx ON backup_runs(state, completed_at)
  WHERE state = 'VERIFIED';
