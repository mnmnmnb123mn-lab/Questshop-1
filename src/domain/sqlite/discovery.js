import { randomUUID } from 'node:crypto';
import { nowMs, withImmediateTransaction } from '../../db/sqlite.js';
import { enqueueJobInTransaction } from './jobs.js';
import { enqueueNotificationInTransaction } from './notifications.js';
import { QuestshopError } from '../../shared/errors.js';

function caseNotification(db, notificationId) {
  const row = db.prepare(`SELECT * FROM notifications WHERE id=? AND notification_type='CUSTOMER_QUEST_DISCOVERY'
    AND aggregate_type='QUEST' AND destination='LOG_QUEST_OPERATIONS'`).get(notificationId);
  if (!row) throw new QuestshopError('DISCOVERY_CASE_NOT_FOUND', 'ไม่พบรายการตรวจ Quest นี้');
  return row;
}

export function retryCustomerDiscovery(db, { notificationId, actorId }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const notification = caseNotification(db, notificationId);
    const questId = notification.aggregate_id;
    const active = db.prepare(`SELECT * FROM jobs WHERE job_type='MONITOR_SEARCH' AND subject_id=?
      AND state IN ('PENDING','RUNNING','RETRY_WAIT')`).get(questId);
    if (!active) enqueueJobInTransaction(db, { jobType: 'MONITOR_SEARCH', subjectType: 'QUEST', subjectId: questId,
      operationKey: `monitor-search:${questId}:${timestamp}`, payload: { questId, requestedBy: actorId }, runAt: timestamp });
    const auditId = randomUUID();
    db.prepare(`INSERT INTO admin_audit(id,actor_id,action,target_type,target_id,reason,after_json,trace_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(auditId, actorId, 'DISCOVERY_RETRY', 'QUEST', questId, 'ตรวจและทดสอบอีกครั้ง',
      JSON.stringify({ queued: !active }), randomUUID(), timestamp);
    enqueueNotificationInTransaction(db, { notificationType: 'ADMIN_LOG', aggregateType: 'ADMIN_AUDIT', aggregateId: auditId,
      destination: 'LOG_ADMIN', payload: { auditId }, timestamp });
    return { questId, queued: !active };
  });
}

export function announceCustomerDiscovery(db, { notificationId, actorId, expectedQuestVersion = null }) {
  const timestamp = nowMs();
  return withImmediateTransaction(db, () => {
    const notification = caseNotification(db, notificationId);
    const quest = db.prepare('SELECT * FROM quests WHERE quest_id=?').get(notification.aggregate_id);
    if (!quest) throw new QuestshopError('QUEST_NOT_FOUND', 'ไม่พบ Quest ที่ต้องการประกาศ');
    if (quest.announcement_status !== 'NOT_ANNOUNCED') return { questId: quest.quest_id, queued: false };
    if (expectedQuestVersion != null && Number(expectedQuestVersion) !== Number(quest.state_version)) {
      throw new QuestshopError('INTERACTION_CONFLICT', 'สถานะ Quest เปลี่ยนแล้ว กรุณาใช้ข้อความล่าสุด');
    }
    enqueueNotificationInTransaction(db, { notificationType: 'QUEST_NEW', aggregateType: 'QUEST', aggregateId: quest.quest_id,
      destination: 'QUEST_NEW', payload: { questId: quest.quest_id, verifiedByMonitor: quest.monitor_status === 'TEST_PASSED' }, timestamp });
    const changed = db.prepare(`UPDATE quests SET announcement_status='QUEUED',state_version=state_version+1,updated_at=?
      WHERE quest_id=? AND announcement_status='NOT_ANNOUNCED' AND state_version=?`).run(timestamp, quest.quest_id, quest.state_version);
    if (!changed.changes) throw new QuestshopError('INTERACTION_CONFLICT', 'สถานะ Quest เปลี่ยนแล้ว กรุณาใช้ข้อความล่าสุด');
    const auditId = randomUUID();
    db.prepare(`INSERT INTO admin_audit(id,actor_id,action,target_type,target_id,reason,after_json,trace_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(auditId, actorId, 'QUEST_ANNOUNCED', 'QUEST', quest.quest_id, 'ส่งประกาศจากข้อมูล Quest',
      JSON.stringify({ monitorVerified: quest.monitor_status === 'TEST_PASSED' }), randomUUID(), timestamp);
    enqueueNotificationInTransaction(db, { notificationType: 'ADMIN_LOG', aggregateType: 'ADMIN_AUDIT', aggregateId: auditId,
      destination: 'LOG_ADMIN', payload: { auditId }, timestamp });
    return { questId: quest.quest_id, queued: true };
  });
}
