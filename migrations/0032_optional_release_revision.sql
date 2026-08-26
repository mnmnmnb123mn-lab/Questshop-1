-- Operators no longer need to supply GIT_SHA. Existing revision evidence is
-- retained, while new deployments without Git metadata use the explicit
-- non-secret compatibility marker `untracked`.
ALTER TABLE release_evidence DROP CONSTRAINT release_evidence_git_sha_check;
ALTER TABLE release_evidence ADD CONSTRAINT release_evidence_git_sha_check
  CHECK (git_sha = 'untracked' OR git_sha ~ '^[0-9a-f]{7,64}$');
