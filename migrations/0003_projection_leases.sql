ALTER TABLE message_projections
  ADD COLUMN lease_owner uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN fencing_token bigint NOT NULL DEFAULT 0;

CREATE INDEX message_projection_lease_idx ON message_projections(lease_expires_at)
WHERE lease_owner IS NOT NULL;
