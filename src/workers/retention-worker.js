import { withTransaction } from '../db/transaction.js';

export async function runRetention({ pool }) {
  return withTransaction({ pool, isolation: 'READ COMMITTED' }, async (client) => {
    const enabled = (await client.query("SELECT enabled FROM feature_gates WHERE gate='RETENTION_JOBS_ENABLED'")).rows[0]?.enabled;
    if (!enabled) return false;
    const operational = (await client.query(
      'SELECT questshop_prune_operational_details() AS result',
    )).rows[0].result;
    const ledgerDeleted = Number((await client.query(
      'SELECT questshop_prune_wallet_ledger() AS count',
    )).rows[0].count);
    await client.query(`WITH stale AS (SELECT id FROM interaction_sessions
      WHERE state IN ('CONFIRMED','EXPIRED','CANCELLED','TERMINAL')
        AND updated_at<clock_timestamp()-interval '7 days'
      ORDER BY updated_at,id LIMIT 500 FOR UPDATE SKIP LOCKED)
      DELETE FROM interaction_sessions AS session USING stale WHERE session.id=stale.id`);
    await client.query(`DELETE FROM topup_sensitive_payloads WHERE topup_id IN (SELECT p.topup_id
      FROM topup_sensitive_payloads p JOIN topups t ON t.id=p.topup_id
      WHERE p.log_delivered_at<clock_timestamp()-interval '7 days'
      AND t.status IN ('CREDITED','INVALID','EXPIRED','ALREADY_REDEEMED','FAILED','REJECTED','REVERSED') LIMIT 500)`);
    await client.query(`DELETE FROM operation_metrics WHERE id IN (SELECT id FROM operation_metrics
      WHERE created_at<clock_timestamp()-interval '90 days' LIMIT 500)`);
    await client.query(`DELETE FROM customer_rate_limit_events WHERE id IN (SELECT id FROM customer_rate_limit_events
      WHERE created_at<clock_timestamp()-interval '7 days' LIMIT 500)`);
    await client.query(`DELETE FROM delivery_attempts WHERE id IN (SELECT d.id FROM delivery_attempts d
      JOIN outbox_events o ON o.id=d.outbox_id WHERE o.state='DELIVERED'
      AND d.created_at<clock_timestamp()-interval '90 days' LIMIT 500)`);
    await client.query(`DELETE FROM runner_attempts WHERE id IN (SELECT a.id FROM runner_attempts a
      JOIN runner_jobs j ON j.id=a.job_id WHERE j.state IN ('COMPLETED','FAILED')
      AND a.started_at<clock_timestamp()-interval '90 days' AND NOT EXISTS(
        SELECT 1 FROM manual_reviews r WHERE r.subject_type='ORDER_ITEM'
        AND r.subject_id=j.order_item_id::text AND r.state<>'RESOLVED')
      AND NOT EXISTS(SELECT 1 FROM runner_attempts child WHERE child.parent_attempt_id=a.id)
      LIMIT 500)`);
    return { ledgerDeleted, operational };
  });
}
