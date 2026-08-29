import { randomUUID } from 'node:crypto';
import { nowMs, withImmediateTransaction } from '../../db/sqlite.js';

export function enqueueJob(db, { jobType, subjectType, subjectId, operationKey, payload = {}, runAt = nowMs() }) {
  return withImmediateTransaction(db, () => enqueueJobInTransaction(db, {
    jobType, subjectType, subjectId, operationKey, payload, runAt,
  }));
}

export function enqueueJobInTransaction(db, { jobType, subjectType, subjectId, operationKey, payload = {}, runAt = nowMs() }) {
  const existing = db.prepare('SELECT * FROM jobs WHERE operation_key=?').get(operationKey);
  if (existing) return existing;
  const id = randomUUID();
  db.prepare(`INSERT INTO jobs(id,job_type,subject_type,subject_id,operation_key,state,checkpoint,next_run_at,payload_json,created_at,updated_at)
    VALUES(?,?,?,?,?,'PENDING','NOT_STARTED',?,?,?,?)`).run(
    id, jobType, subjectType, subjectId, operationKey, runAt, JSON.stringify(payload), runAt, runAt,
  );
  return db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
}

export function claimDueJob(db, { now = nowMs(), leaseMs = 30_000, jobType = null, excludeJobTypes = [] } = {}) {
  return withImmediateTransaction(db, () => {
    const exclusions = Array.isArray(excludeJobTypes) ? excludeJobTypes.filter(Boolean).map(String) : [];
    const typeClause = jobType ? ' AND j.job_type=?' : '';
    const exclusionClause = exclusions.length ? ` AND j.job_type NOT IN (${exclusions.map(() => '?').join(',')})` : '';
    const due = db.prepare(`SELECT j.* FROM jobs j WHERE j.state IN ('PENDING','RETRY_WAIT') AND j.next_run_at<=?${typeClause}${exclusionClause}
      AND (j.job_type<>'QUEST_RUN' OR NOT EXISTS (
        SELECT 1 FROM jobs running
        JOIN order_items running_item ON running_item.id=running.subject_id
        JOIN orders running_order ON running_order.id=running_item.order_id
        JOIN order_items candidate_item ON candidate_item.id=j.subject_id
        JOIN orders candidate_order ON candidate_order.id=candidate_item.order_id
        WHERE running.job_type='QUEST_RUN' AND running.state='RUNNING'
          AND running_order.quest_account_id=candidate_order.quest_account_id
      ))
      ORDER BY CASE WHEN j.job_type='PAYMENT_SETTLE' THEN 0 ELSE 1 END,j.next_run_at,j.created_at LIMIT 1`).get(now, ...(jobType ? [jobType] : []), ...exclusions);
    if (!due) return null;
    const leaseToken = randomUUID();
    const updated = db.prepare(`UPDATE jobs SET state='RUNNING',lease_token=?,lease_expires_at=?,attempt_count=attempt_count+1,
      updated_at=? WHERE id=? AND state IN ('PENDING','RETRY_WAIT')`).run(leaseToken, now + leaseMs, now, due.id);
    return updated.changes ? db.prepare('SELECT * FROM jobs WHERE id=?').get(due.id) : null;
  });
}

export function completeJob(db, { jobId, leaseToken, state = 'COMPLETED', checkpoint = 'VERIFIED',
  errorCode = null, retryAt = null, now = nowMs() }) {
  return withImmediateTransaction(db, () => {
    const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
    if (!row || row.lease_token !== leaseToken || row.state !== 'RUNNING') return null;
    const nextState = retryAt == null ? state : 'RETRY_WAIT';
    db.prepare(`UPDATE jobs SET state=?,checkpoint=?,last_error_code=?,next_run_at=?,lease_token=NULL,lease_expires_at=NULL,
      completed_at=?,updated_at=? WHERE id=?`).run(nextState, checkpoint, errorCode, retryAt ?? now,
      nextState === 'COMPLETED' || nextState === 'FAILED' || nextState === 'REVIEW' ? now : null, now, jobId);
    return db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  });
}

export function markJobPossiblySent(db, { jobId, leaseToken, now = nowMs() }) {
  return withImmediateTransaction(db, () => {
    const result = db.prepare(`UPDATE jobs SET checkpoint='POSSIBLY_SENT',updated_at=?
      WHERE id=? AND state='RUNNING' AND lease_token=?`).run(now, jobId, leaseToken);
    return result.changes === 1;
  });
}

export function renewJobLease(db, { jobId, leaseToken, leaseMs = 30_000, now = nowMs() }) {
  return withImmediateTransaction(db, () => {
    const changed = db.prepare(`UPDATE jobs SET lease_expires_at=?,updated_at=?
      WHERE id=? AND state='RUNNING' AND lease_token=?`).run(now + leaseMs, now, jobId, leaseToken);
    return changed.changes === 1;
  });
}

/** Save non-sensitive progress from a running worker.  This is deliberately
 * separate from the external call checkpoint: callers update it only after a
 * safe read or a verified mutation response. */
export function updateRunningJobPayload(db, { jobId, leaseToken, payload, checkpoint = null, now = nowMs() }) {
  return withImmediateTransaction(db, () => {
    const changed = db.prepare(`UPDATE jobs SET payload_json=?,checkpoint=COALESCE(?,checkpoint),updated_at=?
      WHERE id=? AND state='RUNNING' AND lease_token=?`).run(JSON.stringify(payload), checkpoint, now, jobId, leaseToken);
    return changed.changes === 1 ? db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId) : null;
  });
}

export function recoverInterruptedJobs(db, { now = nowMs() } = {}) {
  return withImmediateTransaction(db, () => {
    db.prepare(`UPDATE jobs SET state='PENDING',lease_token=NULL,lease_expires_at=NULL,next_run_at=?,updated_at=?
      WHERE state='RUNNING' AND checkpoint IN ('NOT_STARTED','INTENT_RECORDED') AND lease_expires_at<?`).run(now, now, now);
    db.prepare(`UPDATE jobs SET state='REVIEW',lease_token=NULL,lease_expires_at=NULL,last_error_code='RESTART_AFTER_POSSIBLY_SENT',
      completed_at=?,updated_at=? WHERE state='RUNNING' AND checkpoint='POSSIBLY_SENT' AND lease_expires_at<?`).run(now, now, now);
  });
}
