-- Bind a projection lease token to every outbox delivery.  Owner alone is not
-- enough after expiry because a long-lived worker may reuse its holder UUID.
ALTER TABLE outbox_events
  ADD COLUMN projection_fencing_token bigint;

CREATE INDEX outbox_projection_fencing_idx
  ON outbox_events(projection_id, projection_fencing_token)
  WHERE projection_id IS NOT NULL;
