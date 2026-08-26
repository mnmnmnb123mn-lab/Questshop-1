-- Release evidence is separate from mutable runtime configuration.  It proves
-- exactly which pre-launch gate/closeout action an Owner approved at a given
-- application revision without storing any secret or provider payload.
CREATE TABLE release_evidence (
  id uuid PRIMARY KEY,
  evidence_type text NOT NULL CHECK (evidence_type IN ('PRELAUNCH_GATE', 'PRELAUNCH_CLOSEOUT')),
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  prelaunch boolean NOT NULL,
  git_sha text NOT NULL CHECK (git_sha ~ '^[0-9a-f]{7,64}$'),
  app_version text NOT NULL,
  engine_version text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX release_evidence_revision_idx
  ON release_evidence(git_sha, evidence_type, created_at DESC);

REVOKE UPDATE, DELETE ON release_evidence FROM PUBLIC;
