ALTER TABLE topups ADD COLUMN details_redacted_at timestamptz;
ALTER TABLE orders ADD COLUMN details_redacted_at timestamptz;

CREATE OR REPLACE FUNCTION questshop_prune_operational_details(
  yearly_cutoff timestamptz DEFAULT clock_timestamp() - interval '1 year',
  operational_cutoff timestamptz DEFAULT clock_timestamp() - interval '90 days',
  batch_limit integer DEFAULT 500
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  refund_count integer := 0; audit_count integer := 0; attempt_count integer := 0;
  review_count integer := 0; dlq_count integer := 0; incident_count integer := 0;
  outbox_count integer := 0; topup_redacted integer := 0; order_redacted integer := 0;
  resolved_state constant text := 'RESOLVED';
BEGIN
  IF batch_limit < 1 OR batch_limit > 500 THEN RAISE EXCEPTION 'batch_limit must be between 1 and 500'; END IF;

  WITH candidates AS (SELECT f.id FROM refunds f WHERE f.created_at < yearly_cutoff
    AND NOT EXISTS(SELECT 1 FROM manual_reviews r WHERE r.subject_type='ORDER_ITEM'
    AND r.subject_id=f.order_item_id::text AND r.state<>resolved_state)
    ORDER BY f.created_at LIMIT batch_limit), deleted AS (
      DELETE FROM refunds f USING candidates c WHERE f.id=c.id RETURNING f.id)
  SELECT count(*)::integer INTO refund_count FROM deleted;

  WITH candidates AS (SELECT id FROM admin_audit_logs WHERE created_at<yearly_cutoff
    ORDER BY created_at LIMIT batch_limit), deleted AS (
      DELETE FROM admin_audit_logs a USING candidates c WHERE a.id=c.id RETURNING a.id)
  SELECT count(*)::integer INTO audit_count FROM deleted;

  WITH candidates AS (SELECT a.id FROM payment_attempts a JOIN topups t ON t.id=a.topup_id
    WHERE a.started_at<operational_cutoff AND t.status IN ('CREDITED','INVALID','EXPIRED',
      'ALREADY_REDEEMED','FAILED','REJECTED','REVERSED')
      AND NOT EXISTS(SELECT 1 FROM manual_reviews r WHERE r.subject_type='TOPUP'
        AND r.subject_id=t.id::text AND r.state<>resolved_state)
      AND NOT EXISTS(SELECT 1 FROM payment_attempts child WHERE child.parent_attempt_id=a.id)
    ORDER BY a.started_at LIMIT batch_limit), deleted AS (
      DELETE FROM payment_attempts a USING candidates c WHERE a.id=c.id RETURNING a.id)
  SELECT count(*)::integer INTO attempt_count FROM deleted;

  WITH candidates AS (SELECT r.id FROM manual_reviews r WHERE r.state=resolved_state
    AND r.resolved_at<operational_cutoff ORDER BY r.resolved_at LIMIT batch_limit),
  evidence AS (DELETE FROM review_evidence e USING candidates c WHERE e.review_id=c.id),
  decisions AS (DELETE FROM review_decisions d USING candidates c WHERE d.review_id=c.id),
  deleted AS (DELETE FROM manual_reviews r USING candidates c WHERE r.id=c.id RETURNING r.id)
  SELECT count(*)::integer INTO review_count FROM deleted;

  WITH candidates AS (SELECT id FROM dead_letter_items WHERE state IN (resolved_state,'DISCARDED')
    AND resolved_at<operational_cutoff ORDER BY resolved_at LIMIT batch_limit), deleted AS (
      DELETE FROM dead_letter_items d USING candidates c WHERE d.id=c.id RETURNING d.id)
  SELECT count(*)::integer INTO dlq_count FROM deleted;

  WITH candidates AS (SELECT id FROM incidents WHERE state=resolved_state AND resolved_at<operational_cutoff
    ORDER BY resolved_at LIMIT batch_limit), deleted AS (
      DELETE FROM incidents i USING candidates c WHERE i.id=c.id RETURNING i.id)
  SELECT count(*)::integer INTO incident_count FROM deleted;

  WITH candidates AS (SELECT id FROM outbox_events WHERE state='DELIVERED'
    AND delivered_at<operational_cutoff ORDER BY delivered_at LIMIT batch_limit),
  attempts AS (DELETE FROM delivery_attempts a USING candidates c WHERE a.outbox_id=c.id),
  deleted AS (DELETE FROM outbox_events o USING candidates c WHERE o.id=c.id RETURNING o.id)
  SELECT count(*)::integer INTO outbox_count FROM deleted;

  WITH candidates AS (SELECT id FROM topups WHERE updated_at<yearly_cutoff
    AND status IN ('CREDITED','INVALID','EXPIRED','ALREADY_REDEEMED','FAILED','REJECTED','REVERSED')
    AND details_redacted_at IS NULL AND NOT EXISTS(SELECT 1 FROM manual_reviews r
      WHERE r.subject_type='TOPUP' AND r.subject_id=topups.id::text AND r.state<>resolved_state)
    ORDER BY updated_at LIMIT batch_limit), updated AS (
      UPDATE topups t SET sender_name=NULL,sender_phone=NULL,failure_code=NULL,
        details_redacted_at=clock_timestamp() FROM candidates c WHERE t.id=c.id RETURNING t.id)
  SELECT count(*)::integer INTO topup_redacted FROM updated;

  WITH candidates AS (SELECT id FROM orders WHERE completed_at<yearly_cutoff
    AND details_redacted_at IS NULL AND NOT EXISTS(SELECT 1 FROM order_items i JOIN manual_reviews r
      ON r.subject_type='ORDER_ITEM' AND r.subject_id=i.id::text
      WHERE i.order_id=orders.id AND r.state<>resolved_state)
    ORDER BY completed_at LIMIT batch_limit), updated AS (
      UPDATE orders o SET account_username=NULL,account_avatar_url=NULL,
        details_redacted_at=clock_timestamp() FROM candidates c WHERE o.id=c.id RETURNING o.id)
  SELECT count(*)::integer INTO order_redacted FROM updated;

  RETURN jsonb_build_object('refunds',refund_count,'adminAudits',audit_count,
    'paymentAttempts',attempt_count,'reviews',review_count,'dlq',dlq_count,
    'incidents',incident_count,'outbox',outbox_count,'topupsRedacted',topup_redacted,
    'ordersRedacted',order_redacted);
END;
$$;

REVOKE ALL ON FUNCTION questshop_prune_operational_details(timestamptz,timestamptz,integer) FROM PUBLIC;
