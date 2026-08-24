import { v7 as uuidv7 } from 'uuid';
import { withTransaction } from '../../db/transaction.js';
import { AuthorizationError, QuestshopError } from '../../shared/errors.js';
import { recordTransition } from '../shared/transition.js';

export async function createAdminSession({ id = uuidv7(), actorId, guildId, channelId, messageId,
  operation, payload, configVersion, ttlMinutes = 5, state = messageId ? 'ACTIVE' : 'PENDING_BIND' }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => (
    (await client.query(`INSERT INTO interaction_sessions(id,actor_id,guild_id,channel_id,message_id,
      operation,state,config_version,payload,trace_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
      clock_timestamp()+make_interval(mins=>$11)) RETURNING *`, [id, actorId, guildId,
      channelId, messageId, operation, state, configVersion, payload, context.traceId, ttlMinutes])).rows[0]
  ));
}

export async function advanceAdminSession({
  parentSession,
  actorId,
  guildId,
  child,
}, context, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED', maxAttempts: 1 }, async (client) => {
    const current = (await client.query(`SELECT *,expires_at>clock_timestamp() AS fresh
      FROM interaction_sessions WHERE id=$1 FOR UPDATE`,
      [parentSession.id])).rows[0];
    if (!current?.fresh || current.actor_id !== actorId || current.guild_id !== guildId || current.state !== 'ACTIVE'
      || Number(current.state_version) !== Number(parentSession.state_version)) {
      throw new QuestshopError('STALE_SESSION', 'เซสชันถูกใช้หรือหมดอายุแล้ว');
    }
    const terminated = (await client.query(`UPDATE interaction_sessions SET state='TERMINAL',
        state_version=state_version+1,updated_at=clock_timestamp()
        WHERE id=$1 AND state='ACTIVE' AND state_version=$2 RETURNING *`,
    [current.id, current.state_version])).rows[0];
    if (!terminated) throw new QuestshopError('STALE_SESSION', 'เซสชันถูกแก้ไขระหว่างดำเนินการ');
    await recordTransition(client, { aggregateType: 'INTERACTION_SESSION', aggregateId: current.id,
      fromState: current.state, toState: terminated.state, stateVersion: terminated.state_version, context });
    const childState = child.state ?? (child.messageId ? 'ACTIVE' : 'PENDING_BIND');
    const next = (await client.query(`INSERT INTO interaction_sessions(id,actor_id,guild_id,channel_id,message_id,
        operation,state,config_version,payload,trace_id,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+make_interval(mins=>$11)) RETURNING *`, [
      child.id ?? uuidv7(),
      actorId, guildId, child.channelId, child.messageId ?? null, child.operation,
      childState, child.configVersion, child.payload ?? {}, context.traceId, child.ttlMinutes ?? 5,
    ])).rows[0];
    return next;
  });
}

export async function loadAdminSession({ sessionId, actorId, guildId, channelId = null,
  messageId = null, operation }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED', maxAttempts: 1 }, async (client) => {
    const row = (await client.query(`SELECT *,expires_at>clock_timestamp() AS fresh
      FROM interaction_sessions WHERE id=$1`, [sessionId])).rows[0];
    if (!row?.fresh || row.state!=='ACTIVE' || row.operation!==operation) throw new QuestshopError('SESSION_EXPIRED', 'เซสชัน Admin หมดอายุ');
    if (row.actor_id!==actorId || row.guild_id!==guildId) throw new AuthorizationError('เซสชัน Admin เป็นของผู้ใช้อื่น');
    if (channelId && row.channel_id!==channelId) throw new AuthorizationError('เซสชันถูกเรียกจากห้องอื่น');
    // Modal submissions do not reliably carry their source message.  Keep the
    // source-message check whenever Discord supplies one; actor/guild/
    // operation/session CAS still protect modal submissions when it does not.
    const effectiveMessageId = messageId ?? context?.messageId;
    if (effectiveMessageId != null && row.message_id && row.message_id !== effectiveMessageId) {
      throw new AuthorizationError('เซสชันถูกเรียกจากข้อความอื่น');
    }
    return row;
  });
}

export async function bindSessionMessage({ sessionId, actorId, guildId, messageId,
  expectedVersion = null }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED', maxAttempts: 1 }, async (client) => {
    const current = (await client.query(`SELECT * FROM interaction_sessions WHERE id=$1 FOR UPDATE`, [sessionId])).rows[0];
    if (!current || current.actor_id !== actorId || current.guild_id !== guildId
      || !['ACTIVE', 'PENDING_BIND'].includes(current.state)) {
      throw new QuestshopError('STALE_SESSION', 'เซสชันถูกแก้ไขหรือหมดอายุแล้ว');
    }
    if (current.message_id === messageId && current.state === 'ACTIVE') return current;
    const allowedInitialRebind = current.state === 'PENDING_BIND'
      || (current.state === 'ACTIVE' && Number(current.state_version) === 1);
    if (!allowedInitialRebind || (expectedVersion != null && Number(current.state_version) !== Number(expectedVersion))) {
      throw new QuestshopError('STALE_SESSION', 'เซสชันถูกแก้ไขหรือหมดอายุแล้ว');
    }
    const updated = (await client.query(`UPDATE interaction_sessions
      SET message_id=$2,state='ACTIVE',state_version=state_version+1,updated_at=clock_timestamp()
      WHERE id=$1 AND state_version=$3 RETURNING *`, [sessionId, messageId, current.state_version])).rows[0];
    if (!updated) throw new QuestshopError('STALE_SESSION', 'เซสชันถูกแก้ไขระหว่างดำเนินการ');
    if (current.state !== updated.state) {
      await recordTransition(client, { aggregateType: 'INTERACTION_SESSION', aggregateId: sessionId,
        fromState: current.state, toState: updated.state, stateVersion: updated.state_version, context });
    }
    return updated;
  });
}

/** Binds every newly-rendered server session to the exact Discord reply that owns its controls. */
export async function bindRenderedSessionMessages({ sessionIds, actorId, guildId, messageId }, context, options = {}) {
  const ids = [...new Set(sessionIds ?? [])];
  if (!ids.length || !messageId) return [];
  return withTransaction({ ...options, isolation: 'READ COMMITTED', maxAttempts: 1 }, async (client) => {
    const sessions = (await client.query(`SELECT * FROM interaction_sessions
      WHERE id = ANY($1::uuid[]) AND actor_id=$2 AND guild_id=$3
      FOR UPDATE`, [ids, actorId, guildId])).rows;
    const bound = [];
    for (const session of sessions) {
      const initialBinding = session.state === 'PENDING_BIND'
        || (session.state === 'ACTIVE' && Number(session.state_version) === 1);
      if (!initialBinding) continue;
      const updated = (await client.query(`UPDATE interaction_sessions
        SET message_id=$2,state='ACTIVE',state_version=state_version+1,updated_at=clock_timestamp()
        WHERE id=$1 AND state_version=$3 RETURNING *`,
      [session.id, messageId, session.state_version])).rows[0];
      if (!updated) throw new QuestshopError('STALE_SESSION', 'เซสชันถูกแก้ไขระหว่างผูกข้อความ');
      if (session.state !== updated.state) {
        await recordTransition(client, { aggregateType: 'INTERACTION_SESSION', aggregateId: session.id,
          fromState: session.state, toState: updated.state, stateVersion: updated.state_version, context });
      }
      bound.push(updated);
    }
    return bound;
  });
}

export async function terminateAdminSession({ sessionId, actorId, guildId, expectedVersion }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED', maxAttempts: 1 }, async (client) => {
    const current = (await client.query(`SELECT * FROM interaction_sessions
      WHERE id=$1 FOR UPDATE`, [sessionId])).rows[0];
    if (!current || current.actor_id !== actorId || current.guild_id !== guildId || current.state !== 'ACTIVE'
      || Number(current.state_version) !== Number(expectedVersion)) {
      throw new QuestshopError('STALE_SESSION', 'เซสชันถูกใช้หรือหมดอายุแล้ว');
    }
    const updated = (await client.query(`UPDATE interaction_sessions
      SET state='TERMINAL',state_version=state_version+1,updated_at=clock_timestamp()
      WHERE id=$1 AND state='ACTIVE' AND state_version=$2 RETURNING *`,
    [sessionId, expectedVersion])).rows[0];
    if (!updated) throw new QuestshopError('STALE_SESSION', 'เซสชันถูกแก้ไขระหว่างดำเนินการ');
    await recordTransition(client, { aggregateType: 'INTERACTION_SESSION', aggregateId: sessionId,
      fromState: current.state, toState: updated.state, stateVersion: updated.state_version, context });
    return updated;
  });
}
