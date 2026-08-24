import { v7 as uuidv7 } from 'uuid';
import { StaleStateError } from '../../shared/errors.js';

export function assertTransition(graph, current, next) {
  const allowed = graph[current] ?? [];
  if (!allowed.includes(next)) {
    throw new TypeError(`Illegal transition ${current} -> ${next}`);
  }
}

export async function recordTransition(client, {
  aggregateType,
  aggregateId,
  fromState,
  toState,
  stateVersion,
  reasonCode = null,
  metadata = {},
  context,
}) {
  await client.query(`
    INSERT INTO state_transitions(
      id, aggregate_type, aggregate_id, from_state, to_state, state_version,
      actor_type, actor_id, trace_id, causation_id, reason_code, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  `, [
    uuidv7(), aggregateType, String(aggregateId), fromState, toState, stateVersion,
    context.actorType, context.actorId, context.traceId, context.causationId,
    reasonCode, metadata,
  ]);
}

export function requireUpdated(result, aggregate, id) {
  if (result.rowCount !== 1) throw new StaleStateError(aggregate, id);
  return result.rows[0];
}

