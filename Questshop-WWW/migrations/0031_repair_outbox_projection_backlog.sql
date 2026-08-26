-- Repair the queue left by pre-projection-version deployments.  Keep durable
-- history, but make one latest queued render authoritative per projection.
-- A leased event is never closed here: it may already be rendering Discord.

-- The newest runnable event becomes the projection's desired version.  This
-- lets its eventual acknowledgement advance delivered_version instead of
-- leaving a negative historical version behind.  A concurrent lease remains
-- untouched and the newer queued event is retained for the next render.
WITH ranked AS (
  SELECT o.id,p.desired_version,
    row_number() OVER (PARTITION BY o.projection_id ORDER BY o.created_at DESC,o.id DESC) AS position
  FROM outbox_events o
  JOIN message_projections p ON p.id=o.projection_id
  WHERE o.state IN ('PENDING','RETRY_WAIT')
)
UPDATE outbox_events o SET projection_version=ranked.desired_version
FROM ranked WHERE o.id=ranked.id AND ranked.position=1
  AND NOT EXISTS(SELECT 1 FROM outbox_events conflict
    WHERE conflict.projection_id=o.projection_id AND conflict.projection_version=ranked.desired_version
      AND conflict.id<>o.id);

-- A lone historical lease is safe to normalize because no queued successor
-- exists.  Do not change a lease that has a newer queued projection waiting.
UPDATE outbox_events o SET projection_version=p.desired_version
FROM message_projections p
WHERE o.projection_id=p.id AND o.state='LEASED'
  AND NOT EXISTS(SELECT 1 FROM outbox_events queued
    WHERE queued.projection_id=o.projection_id AND queued.state IN ('PENDING','RETRY_WAIT'))
  AND NOT EXISTS(SELECT 1 FROM outbox_events conflict
    WHERE conflict.projection_id=o.projection_id AND conflict.projection_version=p.desired_version
      AND conflict.id<>o.id);

-- Close only superseded queued/retry events.  Preserve the newest queued item
-- (even when a lease exists) so a version created during a delivery is never
-- swallowed.  Every closure has append-only transition evidence.
WITH ranked AS (
  SELECT o.id,o.state,o.state_version,o.trace_id,o.causation_id,
    row_number() OVER (PARTITION BY o.projection_id ORDER BY o.created_at DESC,o.id DESC) AS position
  FROM outbox_events o
  WHERE o.projection_id IS NOT NULL AND o.state IN ('PENDING','RETRY_WAIT')
), closed AS (
  UPDATE outbox_events o SET state='DELIVERED',state_version=o.state_version+1,
    delivered_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL
  FROM ranked r WHERE o.id=r.id AND r.position>1
  RETURNING o.id,o.state_version,r.state AS previous_state,r.trace_id,r.causation_id
)
INSERT INTO state_transitions(
  id,aggregate_type,aggregate_id,from_state,to_state,state_version,
  actor_type,actor_id,trace_id,causation_id,reason_code,metadata
)
SELECT gen_random_uuid(),'OUTBOX_EVENT',id::text,previous_state,'DELIVERED',state_version,
  'SYSTEM','migration-0031',trace_id,causation_id,'COALESCED_BY_NEWER_PROJECTION',
  jsonb_build_object('migration',31)
FROM closed;
