import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { withTransaction } from '../../db/transaction.js';
import { FencingLostError } from '../../shared/errors.js';
import { recordTransition } from '../shared/transition.js';

function projectionNonce(id) {
  return createHash('sha256').update(String(id)).digest('base64url').slice(0, 25);
}

function outboxContext(event, actorId) {
  return {
    traceId: event.trace_id,
    causationId: event.causation_id ?? null,
    actorType: 'SYSTEM',
    actorId,
  };
}

async function expiredQuestAnnouncement(client, { projectionType, aggregateType, aggregateId }) {
  if (projectionType !== 'QUEST_NEW' || aggregateType !== 'QUEST') return false;
  const quest = (await client.query(`SELECT sale_state='EXPIRED'
      OR (expires_at IS NOT NULL AND expires_at<=clock_timestamp()) AS expired
    FROM quests WHERE quest_id=$1`, [String(aggregateId)])).rows[0];
  return quest?.expired === true;
}

export async function enqueueProjection(client, {
  projectionType,
  aggregateType,
  aggregateId,
  aggregateVersion,
  surfaceKey,
  topic = 'REFRESH_PROJECTION',
  notBefore = null,
  context,
}) {
  // Public Quest announcements are deny-by-expiry at the durable enqueue
  // boundary as well as discovery. This catches maintenance/Admin/future call
  // sites and prevents historical Discord Quest rows from ever becoming a
  // first-time QUEST_NEW delivery after their deadline has passed.
  if (await expiredQuestAnnouncement(client, { projectionType, aggregateType, aggregateId })) return null;

  const projectionId = uuidv7();
  const projection = (await client.query(`
    INSERT INTO message_projections(
      id, projection_type, aggregate_id, surface_key, nonce, next_allowed_at
    ) VALUES ($1, $2, $3, $4, $5, COALESCE($6, transaction_timestamp()))
    ON CONFLICT (projection_type, aggregate_id, surface_key) DO UPDATE SET
      desired_version = GREATEST(
        message_projections.desired_version + 1,
        EXCLUDED.desired_version
      ),
      next_allowed_at = GREATEST(message_projections.next_allowed_at, EXCLUDED.next_allowed_at),
      updated_at = transaction_timestamp()
    RETURNING *
  `, [projectionId, projectionType, String(aggregateId), surfaceKey, projectionNonce(projectionId), notBefore])).rows[0];

  await client.query(`
    INSERT INTO outbox_events(
      id, topic, aggregate_type, aggregate_id, aggregate_version,
      projection_id, state, available_at, trace_id, causation_id
    ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING',
      COALESCE($7, transaction_timestamp()), $8, $9)
    ON CONFLICT (topic, aggregate_type, aggregate_id, aggregate_version) DO NOTHING
  `, [
    uuidv7(), topic, aggregateType, String(aggregateId), aggregateVersion,
    projection.id, notBefore, context.traceId, context.causationId,
  ]);
  return projection;
}

export async function acquireDelivery({ holder, ttlSeconds = 30 }, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const result = await client.query(`
      WITH candidate AS (
        SELECT o.id,o.state AS previous_state FROM outbox_events o
        JOIN message_projections p ON p.id=o.projection_id
        WHERE (p.surface_key LIKE 'DM:%' OR EXISTS(
          SELECT 1 FROM surfaces s WHERE s.surface_key=p.surface_key AND s.state='ACTIVE'
        )) AND (p.surface_key IS DISTINCT FROM 'QUEST_NEW' OR EXISTS(
          SELECT 1 FROM feature_gates g WHERE g.gate='QUEST_ANNOUNCEMENT_ENABLED' AND g.enabled=true
        )) AND ((
          o.state IN ('PENDING', 'RETRY_WAIT') AND o.available_at <= clock_timestamp()
        ) OR (
          o.state = 'LEASED' AND o.lease_expires_at <= clock_timestamp()
        )) AND (p.lease_owner IS NULL OR p.lease_expires_at<=clock_timestamp())
        ORDER BY o.available_at, o.created_at
        FOR UPDATE OF o,p SKIP LOCKED
        LIMIT 1
      )
      UPDATE outbox_events o
      SET state = 'LEASED',
          state_version = o.state_version + 1,
          lease_owner = $1,
          lease_expires_at = clock_timestamp() + make_interval(secs => $2),
          fencing_token = o.fencing_token + 1,
          attempt_count = o.attempt_count + 1
      FROM candidate
      WHERE o.id = candidate.id
      RETURNING o.*,candidate.previous_state
    `, [holder, ttlSeconds]);
    const event = result.rows[0] ?? null;
    if (event?.projection_id) {
      const projection = (await client.query(`UPDATE message_projections SET lease_owner=$2,
        lease_expires_at=clock_timestamp()+make_interval(secs=>$3),fencing_token=fencing_token+1
        WHERE id=$1 RETURNING fencing_token`, [event.projection_id, holder, ttlSeconds])).rows[0];
      if (!projection) throw new FencingLostError(`projection:${event.projection_id}`);
      const updated = (await client.query(`UPDATE outbox_events SET projection_fencing_token=$4
        WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 RETURNING projection_fencing_token`,
      [event.id, holder, event.fencing_token, projection.fencing_token])).rows[0];
      if (!updated) throw new FencingLostError(`outbox:${event.id}`);
      event.projection_fencing_token = updated.projection_fencing_token;
    }
    if (event && event.previous_state !== 'LEASED') {
      await recordTransition(client, { aggregateType: 'OUTBOX_EVENT', aggregateId: event.id,
        fromState: event.previous_state, toState: 'LEASED', stateVersion: event.state_version,
        reasonCode: 'OUTBOX_LEASED', context: outboxContext(event, holder) });
    }
    return event;
  });
}

export async function recordDelivery({
  outboxId,
  holder,
  fencingToken,
  messageId = null,
  pingSent = false,
  suppressQuestAnnouncement = false,
}, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const event = (await client.query(`SELECT * FROM outbox_events
      WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3
        AND lease_expires_at>clock_timestamp() FOR UPDATE`,
    [outboxId, holder, fencingToken])).rows[0];
    if (!event) return null;
    let projection = null;
    if (event.projection_id) {
      projection = (await client.query(`
        UPDATE message_projections
        SET message_id = COALESCE($2, message_id),
            delivered_version = desired_version,
            ping_sent_at = CASE
              WHEN $5 AND ping_sent_at IS NULL THEN clock_timestamp()
              ELSE ping_sent_at
            END,
            last_error_code = NULL, lease_owner=NULL, lease_expires_at=NULL,
            updated_at = clock_timestamp()
        WHERE id = $1 AND lease_owner=$3 AND fencing_token=$4 AND lease_expires_at>clock_timestamp()
        RETURNING *
      `, [event.projection_id, messageId, holder, event.projection_fencing_token, pingSent])).rows[0];
      // The projection lease is part of the same ownership contract.  If it
      // was renewed/taken by another worker, leave the event untouched for
      // that worker instead of acknowledging a stale delivery.
      if (!projection) throw new FencingLostError(`projection:${event.projection_id}`);
    }
    const delivered = (await client.query(`
      UPDATE outbox_events
      SET state = 'DELIVERED', delivered_at = clock_timestamp(),
          state_version = state_version + 1,
          lease_owner = NULL, lease_expires_at = NULL
      WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3
        AND state_version = $4 AND lease_expires_at > clock_timestamp()
      RETURNING *
    `, [outboxId, holder, fencingToken, event.state_version])).rows[0];
    if (!delivered) throw new FencingLostError(`outbox:${outboxId}`);
    const context = outboxContext(event, holder);
    await recordTransition(client, { aggregateType: 'OUTBOX_EVENT', aggregateId: event.id,
      fromState: 'LEASED', toState: 'DELIVERED', stateVersion: delivered.state_version,
      reasonCode: suppressQuestAnnouncement ? 'QUEST_ANNOUNCEMENT_EXPIRED' : 'OUTBOX_DELIVERED', context });
    await client.query(`INSERT INTO delivery_attempts(id,outbox_id,attempt_number,outcome,evidence)
      VALUES($1,$2,$3,'DELIVERED',$4) ON CONFLICT(outbox_id,attempt_number) DO NOTHING`,
    [uuidv7(), event.id, event.attempt_count,
      suppressQuestAnnouncement ? { suppressed: 'QUEST_EXPIRED' } : {}]);
    await client.query(`INSERT INTO operation_metrics(id,operation,outcome,duration_ms,trace_id)
      VALUES($1,'OUTBOX_DELIVERY','SUCCESS',GREATEST(0,floor(extract(epoch FROM clock_timestamp()-$2::timestamptz)*1000))::integer,$3)`,
    [uuidv7(), event.created_at, event.trace_id]);
    if (projection) {
      if (projection?.projection_type === 'PAYMENT_LOG') {
        await client.query(`UPDATE topup_sensitive_payloads SET log_delivered_at=clock_timestamp()
          WHERE topup_id=$1`, [projection.aggregate_id]);
      }
      if (projection?.projection_type === 'QUEST_NEW' && !suppressQuestAnnouncement) {
        await client.query(`UPDATE quests SET announcement_state='ANNOUNCED',
          announcement_version=announcement_version+CASE WHEN announcement_state='NOT_ANNOUNCED' THEN 1 ELSE 0 END,
          updated_at=clock_timestamp() WHERE quest_id=$1`, [projection.aggregate_id]);
      }
      // One successful render is the latest state of the projection. Older
      // queued notifications for the same message must not edit that message
      // again; they are durably coalesced rather than silently discarded.
      const coalesced = await client.query(`WITH obsolete AS (
        SELECT id,state AS previous_state FROM outbox_events
        WHERE projection_id=$1 AND id<>$2 AND state IN ('PENDING','RETRY_WAIT') FOR UPDATE
      ) UPDATE outbox_events SET state='DELIVERED',state_version=outbox_events.state_version+1,
        delivered_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL
        FROM obsolete WHERE outbox_events.id=obsolete.id
        RETURNING outbox_events.*,obsolete.previous_state`,
      [event.projection_id, event.id]);
      for (const obsolete of coalesced.rows) await recordTransition(client, {
        aggregateType: 'OUTBOX_EVENT', aggregateId: obsolete.id, fromState: obsolete.previous_state,
        toState: 'DELIVERED', stateVersion: obsolete.state_version,
        reasonCode: 'COALESCED_BY_NEWER_PROJECTION', context: outboxContext(obsolete, holder),
      });
    }
    const resolvedDlq = await client.query(`UPDATE dead_letter_items SET state='RESOLVED',state_version=state_version+1,
      resolved_at=clock_timestamp() WHERE state='PENDING' AND evidence->>'replayOutboxId'=$1 RETURNING *`, [event.id]);
    for (const dlq of resolvedDlq.rows) await recordTransition(client, {
      aggregateType: 'DEAD_LETTER', aggregateId: dlq.id, fromState: 'PENDING', toState: 'RESOLVED',
      stateVersion: dlq.state_version, reasonCode: 'REPLAY_DELIVERED', context,
    });
    return delivered;
  });
}

export async function renewDeliveryLease({
  outboxId,
  holder,
  fencingToken,
  ttlSeconds = 30,
}, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const event = (await client.query(`SELECT * FROM outbox_events
      WHERE id=$1 AND state='LEASED' AND lease_owner=$2 AND fencing_token=$3
        AND lease_expires_at>clock_timestamp() FOR UPDATE`,
    [outboxId, holder, fencingToken])).rows[0];
    if (!event) return null;
    if (event.projection_id) {
      const projection = (await client.query(`UPDATE message_projections
        SET lease_expires_at=clock_timestamp()+make_interval(secs=>$4),updated_at=clock_timestamp()
        WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 AND lease_expires_at>clock_timestamp()
        RETURNING id`, [event.projection_id, holder, event.projection_fencing_token, ttlSeconds])).rows[0];
      if (!projection) return null;
    }
    return (await client.query(`UPDATE outbox_events
      SET lease_expires_at=clock_timestamp()+make_interval(secs=>$4)
      WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 AND lease_expires_at>clock_timestamp()
      RETURNING *`, [outboxId, holder, fencingToken, ttlSeconds])).rows[0] ?? null;
  });
}
