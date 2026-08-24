CREATE OR REPLACE FUNCTION questshop_prune_wallet_ledger(
  cutoff timestamptz DEFAULT clock_timestamp() - interval '1 year',
  batch_limit integer DEFAULT 500
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF batch_limit < 1 OR batch_limit > 500 THEN
    RAISE EXCEPTION 'batch_limit must be between 1 and 500';
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT t.* FROM wallet_transactions t
    WHERE t.created_at < cutoff
      AND NOT EXISTS (
        SELECT 1 FROM manual_reviews r
        LEFT JOIN wallet_transactions protected
          ON protected.discord_user_id = t.discord_user_id
         AND ((r.subject_type = 'TOPUP' AND protected.reference_type = 'TOPUP'
           AND r.subject_id = protected.reference_id)
          OR (r.subject_type = 'ORDER_ITEM' AND protected.reference_type = 'ORDER_ITEM'
           AND r.subject_id = protected.reference_id))
        WHERE r.state <> 'RESOLVED'
          AND (protected.id IS NOT NULL OR r.subject_type = 'FINANCIAL')
      )
    ORDER BY t.discord_user_id, t.created_at, t.id
    FOR UPDATE SKIP LOCKED
    LIMIT batch_limit
  ), boundaries AS (
    SELECT DISTINCT ON (discord_user_id) * FROM candidates
    ORDER BY discord_user_id, created_at DESC, id DESC
  ), checkpoints AS (
    INSERT INTO wallet_checkpoints(id,discord_user_id,through_transaction_id,
      available_cents,reserved_cents,chain_hash,trace_id)
    SELECT gen_random_uuid(),discord_user_id,id,available_after_cents,reserved_after_cents,
      entry_hash,trace_id FROM boundaries
    ON CONFLICT (discord_user_id,through_transaction_id) DO NOTHING
  ), deleted AS (
    DELETE FROM wallet_transactions t USING candidates c WHERE t.id=c.id RETURNING t.id
  )
  SELECT count(*)::integer INTO deleted_count FROM deleted;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION questshop_prune_wallet_ledger(timestamptz, integer) FROM PUBLIC;

