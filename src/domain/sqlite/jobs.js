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
    const updated = db.prepare(`UPDATE jobs SET state='RUNNING',state_version=state_version+1,lease_token=?,lease_expires_at=?,attempt_count=attempt_count+1,
      updated_at=? WHERE id=? AND state IN ('PENDING','RETRY_WAIT')`).run(leaseToken, now + leaseMs, now, due.id);
    return updated.changes ? db.prepare('SELECT * FROM jobs WHERE id=?').get(due.id) : null;
  });
}

export function completeJob(db, { jobId, leaseToken, state = 'COMPLETED', checkpoint = 'VERIFIED',
  errorCode = null, retryAt = null, expectedStateVersion = null, now = nowMs() }) {
  return withImmediateTransaction(db, () => {
    const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
    if (!row || row.lease_token !== leaseToken || row.state !== 'RUNNING'
      || (expectedStateVersion != null && row.state_version !== expectedStateVersion)) return null;
    const nextState = retryAt == null ? state : 'RETRY_WAIT';
    db.prepare(`UPDATE jobs SET state=?,checkpoint=?,state_version=state_version+1,last_error_code=?,next_run_at=?,lease_token=NULL,lease_expires_at=NULL,
      completed_at=?,updated_at=? WHERE id=?`).run(nextState, checkpoint, errorCode, retryAt ?? now,
      nextState === 'COMPLETED' || nextState === 'FAILED' || nextState === 'REVIEW' ? now : null, now, jobId);
    return db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  });
}

/**
 * Fence worker-side aggregate writes.  A lease token is an authority, not a
 * best-effort hint: once it is lost, the old worker cannot record a provider
 * result, progress, or settlement over a newer delivery.  Call only inside
 * the same BEGIN IMMEDIATE transaction as the protected aggregate mutation.
 */
export function assertActiveJobLeaseInTransaction(db, {
  jobId, leaseToken, subjectType, subjectId, expectedStateVersion = null,
}) {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  if (!job || job.state !== 'RUNNING' || job.lease_token !== leaseToken
    || job.subject_type !== subjectType || job.subject_id !== subjectId
    || (expectedStateVersion != null && job.state_version !== expectedStateVersion)) {
    const error = new Error('Worker lease is no longer authoritative');
    error.code = 'JOB_LEASE_LOST';
    throw error;
  }
  return job;
}

export function appendExternalOperationEvidenceInTransaction(db, {
  jobId, subjectType, subjectId, stage, evidence = {}, traceId, timestamp = nowMs(),
}) {
  db.prepare(`INSERT INTO external_operation_evidence(id,job_id,subject_type,subject_id,stage,evidence_json,trace_id,created_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(job_id,stage) DO NOTHING`).run(
    randomUUID(), jobId, subjectType, subjectId, stage, JSON.stringify(evidence), traceId, timestamp,
  );
}

export function markJobPossiblySent(db, { jobId, leaseToken, now = nowMs() }) {
  return withImmediateTransaction(db, () => {
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
    if (!job || job.state !== 'RUNNING' || job.lease_token !== leaseToken) return false;
    const result = db.prepare(`UPDATE jobs SET checkpoint='POSSIBLY_SENT',state_version=state_version+1,updated_at=?
      WHERE id=? AND state='RUNNING' AND lease_token=?`).run(now, jobId, leaseToken);
    if (result.changes) appendExternalOperationEvidenceInTransaction(db, {
      jobId, subjectType: job.subject_type, subjectId: job.subject_id, stage: 'POSSIBLY_SENT',
      traceId: JSON.parse(job.payload_json ?? '{}').traceId ?? job.operation_key, timestamp: now,
    });
    return result.changes === 1;
  });
}

export function renewJobLease(db, { jobId, leaseToken, leaseMs = 30_000, now = nowMs() }) {
  return withImmediateTransaction(db, () => {
    const changed = db.prepare(`UPDATE jobs SET lease_expires_at=?,state_version=state_version+1,updated_at=?
      WHERE id=? AND state='RUNNING' AND lease_token=?`).run(now + leaseMs, now, jobId, leaseToken);
    return changed.changes === 1;
  });
}

/** Save non-sensitive progress from a running worker.  This is deliberately
 * separate from the external call checkpoint: callers update it only after a
 * safe read or a verified mutation response. */
export function updateRunningJobPayload(db, { jobId, leaseToken, payload, checkpoint = null, now = nowMs() }) {
  return withImmediateTransaction(db, () => {
    const changed = db.prepare(`UPDATE jobs SET payload_json=?,checkpoint=COALESCE(?,checkpoint),state_version=state_version+1,updated_at=?
      WHERE id=? AND state='RUNNING' AND lease_token=?`).run(JSON.stringify(payload), checkpoint, now, jobId, leaseToken);
    return changed.changes === 1 ? db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId) : null;
  });
}

export function recoverInterruptedJobs(db, { now = nowMs() } = {}) {
  return withImmediateTransaction(db, () => {
    db.prepare(`UPDATE jobs SET state='PENDING',state_version=state_version+1,lease_token=NULL,lease_expires_at=NULL,next_run_at=?,updated_at=?
      WHERE state='RUNNING' AND checkpoint IN ('NOT_STARTED','INTENT_RECORDED') AND lease_expires_at<?`).run(now, now, now);
    const interrupted = db.prepare(`SELECT * FROM jobs WHERE state='RUNNING' AND checkpoint='POSSIBLY_SENT' AND lease_expires_at<?`).all(now);
    for (const job of interrupted) {
      if (job.job_type === 'PAYMENT_SETTLE') {
        const topup = db.prepare('SELECT * FROM topups WHERE id=?').get(job.subject_id);
        if (topup?.status === 'REDEEMED') {
          // The provider result is durable.  Requeue only the local credit;
          // the worker recognizes REDEEMED and never contacts TrueMoney.
          db.prepare(`UPDATE jobs SET state='PENDING',checkpoint='VERIFIED',state_version=state_version+1,lease_token=NULL,lease_expires_at=NULL,
            next_run_at=?,last_error_code='RECOVER_REDEEMED_CREDIT',updated_at=? WHERE id=?`).run(now, now, job.id);
          appendExternalOperationEvidenceInTransaction(db, { jobId: job.id, subjectType: job.subject_type, subjectId: job.subject_id,
            stage: 'RECOVERY_DECISION', evidence: { decision: 'CREDIT_REDEEMED_WITHOUT_PROVIDER_RETRY' }, traceId: topup.trace_id, timestamp: now });
          continue;
        }
        if (topup && !['CREDITED', 'FAILED', 'REVERSED', 'REVIEW'].includes(topup.status)) {
          db.prepare(`UPDATE topups SET status='REVIEW',failure_reason='RESTART_AFTER_POSSIBLY_SENT',state_version=state_version+1,updated_at=?
            WHERE id=? AND state_version=?`).run(now, topup.id, topup.state_version);
          db.prepare(`INSERT INTO manual_reviews(id,subject_type,subject_id,category,state,reason_code,safe_reason,created_at,updated_at)
            VALUES(?,?,?,'FINANCIAL','OPEN',?,?,?,?) ON CONFLICT(subject_type,subject_id) WHERE state='OPEN'
            DO NOTHING`).run(randomUUID(), 'TOPUP', topup.id, 'RESTART_AFTER_POSSIBLY_SENT',
            'คำขอ TrueMoney อาจถูกส่งแล้วและต้องตรวจสอบด้วยผู้ดูแล', now, now);
          appendExternalOperationEvidenceInTransaction(db, { jobId: job.id, subjectType: job.subject_type, subjectId: job.subject_id,
            stage: 'RECOVERY_DECISION', evidence: { decision: 'FINANCIAL_REVIEW_NO_PROVIDER_RETRY' }, traceId: topup.trace_id, timestamp: now });
        }
      } else if (job.job_type === 'QUEST_RUN') {
        const item = db.prepare(`SELECT i.*,o.trace_id FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.id=?`).get(job.subject_id);
        if (item && ['QUEUED', 'RUNNING'].includes(item.state)) {
          db.prepare(`UPDATE order_items SET state='REVIEW',state_version=state_version+1,updated_at=? WHERE id=? AND state_version=?`)
            .run(now, item.id, item.state_version);
          db.prepare(`INSERT INTO manual_reviews(id,subject_type,subject_id,category,state,reason_code,safe_reason,created_at,updated_at)
            VALUES(?,?,?,'OPERATIONAL','OPEN',?,?,?,?) ON CONFLICT(subject_type,subject_id) WHERE state='OPEN'
            DO NOTHING`).run(randomUUID(), 'ORDER_ITEM', item.id, 'RESTART_AFTER_POSSIBLY_SENT',
            'ผลการทำ Quest อาจเปลี่ยนแล้ว จึงคงยอดจองไว้เพื่อตรวจสอบ', now, now);
          appendExternalOperationEvidenceInTransaction(db, { jobId: job.id, subjectType: job.subject_type, subjectId: job.subject_id,
            stage: 'RECOVERY_DECISION', evidence: { decision: 'OPERATIONAL_REVIEW_RESERVED' }, traceId: item.trace_id, timestamp: now });
        }
      }
      db.prepare(`UPDATE jobs SET state='REVIEW',state_version=state_version+1,lease_token=NULL,lease_expires_at=NULL,last_error_code='RESTART_AFTER_POSSIBLY_SENT',
        completed_at=?,updated_at=? WHERE id=? AND state='RUNNING'`).run(now, now, job.id);
    }
  });
}
