-- A projection may be refreshed many times while Discord is unavailable.
-- Keep the rendered version on each event so an older delivery can never
-- acknowledge a newer projection update.
ALTER TABLE outbox_events ADD COLUMN projection_version bigint;

-- Historical rows receive distinct negative versions. Future desired versions
-- are positive, so this preserves history without collisions.
WITH numbered AS (
  SELECT id, -row_number() OVER (PARTITION BY projection_id ORDER BY created_at,id)::bigint AS version
  FROM outbox_events WHERE projection_id IS NOT NULL
)
UPDATE outbox_events event SET projection_version=numbered.version
FROM numbered WHERE event.id=numbered.id;

ALTER TABLE outbox_events
  DROP CONSTRAINT IF EXISTS outbox_events_topic_aggregate_type_aggregate_id_aggregate_version_key;
ALTER TABLE outbox_events
  DROP CONSTRAINT IF EXISTS outbox_events_topic_aggregate_type_aggregate_id_aggregate_v_key;

CREATE UNIQUE INDEX outbox_events_projection_version_idx
  ON outbox_events(projection_id,projection_version)
  WHERE projection_id IS NOT NULL;

CREATE UNIQUE INDEX outbox_events_unprojected_identity_idx
  ON outbox_events(topic,aggregate_type,aggregate_id,aggregate_version)
  WHERE projection_id IS NULL;

CREATE INDEX outbox_events_pending_projection_idx
  ON outbox_events(projection_id,projection_version)
  WHERE state IN ('PENDING','RETRY_WAIT');
