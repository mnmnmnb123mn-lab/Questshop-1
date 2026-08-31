-- v2 keeps v1 as an immutable draft baseline and upgrades both fresh and
-- populated v1 databases. All rebuilds run in one BEGIN IMMEDIATE transaction.
PRAGMA defer_foreign_keys=ON;

-- State vocabulary migration. Non-financial states are mapped deterministically;
-- financial rows are copied byte-for-byte after migration preflight succeeds.
ALTER TABLE payment_attempts RENAME TO payment_attempts_v1;
DROP TRIGGER promotion_usages_append_only_update;
DROP TRIGGER promotion_usages_append_only_delete;
ALTER TABLE promotion_usages RENAME TO promotion_usages_v1;
ALTER TABLE topups RENAME TO topups_v1;
CREATE TABLE topups (
 id TEXT PRIMARY KEY, discord_user_id TEXT NOT NULL, voucher_hmac_version TEXT NOT NULL DEFAULT 'v1' CHECK (voucher_hmac_version GLOB 'v[0-9]*'), voucher_identity_hmac BLOB NOT NULL UNIQUE, voucher_hmac BLOB NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK (status IN ('PAYMENT_QUEUED','PROCESSING','REDEEMED','CREDITED','FAILED','MANUAL_REVIEW','REVERSED')), prelaunch INTEGER NOT NULL DEFAULT 0 CHECK (prelaunch IN (0,1)),
 principal_cents INTEGER NOT NULL DEFAULT 0 CHECK (principal_cents >= 0), bonus_cents INTEGER NOT NULL DEFAULT 0 CHECK (bonus_cents >= 0), credited_cents INTEGER NOT NULL DEFAULT 0 CHECK (credited_cents >= 0), promotion_snapshot_json TEXT,
 provider_transaction_id TEXT UNIQUE, receiver_last4 TEXT, wallet_transaction_id TEXT UNIQUE REFERENCES wallet_transactions(id), failure_reason TEXT, attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0), state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0), trace_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, redeemed_at INTEGER, credited_at INTEGER
) STRICT;
INSERT INTO topups SELECT id,discord_user_id,voucher_hmac_version,voucher_identity_hmac,voucher_hmac,CASE status WHEN 'PENDING' THEN 'PAYMENT_QUEUED' WHEN 'REVIEW' THEN 'MANUAL_REVIEW' ELSE status END,prelaunch,principal_cents,bonus_cents,credited_cents,promotion_snapshot_json,provider_transaction_id,receiver_last4,wallet_transaction_id,failure_reason,attempt_count,state_version,trace_id,created_at,updated_at,redeemed_at,credited_at FROM topups_v1;
CREATE TABLE payment_attempts (
 id TEXT PRIMARY KEY, topup_id TEXT NOT NULL REFERENCES topups(id), attempt_number INTEGER NOT NULL CHECK (attempt_number > 0), dispatch_state TEXT NOT NULL CHECK (dispatch_state IN ('INTENT_RECORDED','POSSIBLY_SENT','RESPONSE_RECEIVED','CONFIRMED_NOT_SENT')), outcome TEXT CHECK (outcome IS NULL OR outcome IN ('SUCCESS','DEFINITE_FAILURE','AMBIGUOUS')), provider_http_status INTEGER, provider_code TEXT, provider_reference TEXT, reason_code TEXT, evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)), trace_id TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER,
 parent_attempt_id TEXT REFERENCES payment_attempts(id), source TEXT NOT NULL DEFAULT 'PROVIDER' CHECK (source IN ('PROVIDER','OWNER_VERIFICATION','RECOVERY')), error_class TEXT, error_code TEXT, amount_cents INTEGER, currency TEXT, receiver_confirmation TEXT, UNIQUE(topup_id, attempt_number)
) STRICT;
INSERT INTO payment_attempts(id,topup_id,attempt_number,dispatch_state,outcome,provider_http_status,provider_code,provider_reference,reason_code,evidence_json,trace_id,started_at,completed_at,parent_attempt_id,source,error_class,error_code,amount_cents,currency,receiver_confirmation) SELECT id,topup_id,attempt_number,dispatch_state,outcome,provider_http_status,provider_code,provider_reference,reason_code,evidence_json,trace_id,started_at,completed_at,NULL,'PROVIDER',NULL,NULL,NULL,NULL,NULL FROM payment_attempts_v1;
CREATE TABLE promotion_usages (topup_id TEXT PRIMARY KEY REFERENCES topups(id), promotion_id TEXT NOT NULL REFERENCES promotions(id), discord_user_id TEXT NOT NULL, bangkok_day TEXT NOT NULL CHECK (bangkok_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), bonus_cents INTEGER NOT NULL CHECK (bonus_cents >= 0), created_at INTEGER NOT NULL) STRICT;
INSERT INTO promotion_usages SELECT * FROM promotion_usages_v1;
CREATE TRIGGER promotion_usages_append_only_update BEFORE UPDATE ON promotion_usages BEGIN SELECT RAISE(ABORT, 'promotion_usages is append-only'); END;
CREATE TRIGGER promotion_usages_append_only_delete BEFORE DELETE ON promotion_usages BEGIN SELECT RAISE(ABORT, 'promotion_usages is append-only'); END;
DROP TABLE payment_attempts_v1;
DROP TABLE promotion_usages_v1;
DROP TABLE topups_v1;
CREATE INDEX topups_owner_created ON topups(discord_user_id, created_at DESC);
CREATE INDEX topups_recovery ON topups(status, updated_at);
CREATE INDEX payment_attempts_parent ON payment_attempts(parent_attempt_id, started_at);
CREATE INDEX promotion_usages_limit ON promotion_usages(promotion_id,discord_user_id,bangkok_day,created_at);

DROP TRIGGER external_operation_evidence_append_only_update;
DROP TRIGGER external_operation_evidence_append_only_delete;
ALTER TABLE external_operation_evidence RENAME TO external_operation_evidence_v1;
ALTER TABLE jobs RENAME TO jobs_v1;
CREATE TABLE jobs (
 id TEXT PRIMARY KEY, job_type TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, operation_key TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','WAITING_RETRY','WAITING_RATE_LIMIT','COMPLETED','FAILED','REVIEW')), checkpoint TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK (checkpoint IN ('NOT_STARTED','INTENT_RECORDED','POSSIBLY_SENT','VERIFIED')), state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0), attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0), next_run_at INTEGER NOT NULL, last_error_code TEXT, payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)), lease_token TEXT, lease_expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
) STRICT;
INSERT INTO jobs SELECT id,job_type,subject_type,subject_id,operation_key,CASE state WHEN 'RETRY_WAIT' THEN 'WAITING_RETRY' ELSE state END,checkpoint,state_version,attempt_count,next_run_at,last_error_code,payload_json,lease_token,lease_expires_at,created_at,updated_at,completed_at FROM jobs_v1;
CREATE TABLE external_operation_evidence (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL, operation_id TEXT, attempt_id TEXT, job_type TEXT, operation_key TEXT, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, stage TEXT NOT NULL CHECK (stage IN ('INTENT','POSSIBLY_SENT','VERIFIED_RESULT','AMBIGUOUS','RECOVERY_DECISION')), evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)), trace_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(job_id, stage, operation_id)
) STRICT;
INSERT INTO external_operation_evidence(id,job_id,operation_id,attempt_id,job_type,operation_key,subject_type,subject_id,stage,evidence_json,trace_id,created_at) SELECT e.id,e.job_id,NULL,NULL,j.job_type,j.operation_key,e.subject_type,e.subject_id,e.stage,e.evidence_json,e.trace_id,e.created_at FROM external_operation_evidence_v1 e LEFT JOIN jobs j ON j.id=e.job_id;
CREATE TRIGGER external_operation_evidence_append_only_update BEFORE UPDATE ON external_operation_evidence BEGIN SELECT RAISE(ABORT, 'external_operation_evidence is append-only'); END;
CREATE TRIGGER external_operation_evidence_append_only_delete BEFORE DELETE ON external_operation_evidence BEGIN SELECT RAISE(ABORT, 'external_operation_evidence is append-only'); END;
DROP TABLE external_operation_evidence_v1;
DROP TABLE jobs_v1;
CREATE INDEX jobs_runnable ON jobs(state, next_run_at, created_at);
CREATE INDEX jobs_active_monitor_work ON jobs(job_type,state,next_run_at) WHERE job_type IN ('MONITOR_SEARCH','MONITOR_TEST','MONITOR_DISCOVERY');
CREATE UNIQUE INDEX monitor_test_one_active_per_quest ON jobs(json_extract(payload_json,'$.questId')) WHERE job_type='MONITOR_TEST' AND state IN ('PENDING','RUNNING','WAITING_RETRY','WAITING_RATE_LIMIT');
CREATE INDEX external_operation_evidence_subject ON external_operation_evidence(subject_type, subject_id, created_at);

ALTER TABLE order_items RENAME TO order_items_v1;
CREATE TABLE order_items (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), quest_id TEXT NOT NULL REFERENCES quests(quest_id), state TEXT NOT NULL CHECK (state IN ('QUEUED','RUNNING','READY_TO_CLAIM','FAILED_RELEASED','MANUAL_REVIEW','REFUNDED')), price_cents INTEGER NOT NULL CHECK (price_cents > 0), progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100), claim_url TEXT, refund_cents INTEGER NOT NULL DEFAULT 0 CHECK (refund_cents >= 0), state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0), reserved_at INTEGER NOT NULL, completed_at INTEGER, updated_at INTEGER NOT NULL, UNIQUE(order_id, quest_id)
) STRICT;
INSERT INTO order_items SELECT id,order_id,quest_id,CASE state WHEN 'FAILED' THEN 'FAILED_RELEASED' WHEN 'REVIEW' THEN 'MANUAL_REVIEW' ELSE state END,price_cents,progress_percent,claim_url,refund_cents,state_version,reserved_at,completed_at,updated_at FROM order_items_v1;
DROP TABLE order_items_v1;

ALTER TABLE manual_reviews ADD COLUMN active_confirmation_round INTEGER NOT NULL DEFAULT 0 CHECK (active_confirmation_round >= 0);
CREATE TABLE manual_review_confirmations (id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES manual_reviews(id), confirmation_round INTEGER NOT NULL CHECK (confirmation_round > 0), confirmation_step INTEGER NOT NULL CHECK (confirmation_step IN (1,2)), actor_id TEXT NOT NULL, decision TEXT NOT NULL, payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL CHECK (json_valid(payload_json)), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(review_id, confirmation_round, confirmation_step)) STRICT;
CREATE INDEX manual_review_confirmations_lookup ON manual_review_confirmations(review_id, confirmation_round, confirmation_step);
CREATE TRIGGER manual_review_confirmations_append_only_update BEFORE UPDATE ON manual_review_confirmations BEGIN SELECT RAISE(ABORT, 'manual_review_confirmations is append-only'); END;
CREATE TRIGGER manual_review_confirmations_append_only_delete BEFORE DELETE ON manual_review_confirmations BEGIN SELECT RAISE(ABORT, 'manual_review_confirmations is append-only'); END;

ALTER TABLE quests ADD COLUMN discovered_by_customer INTEGER NOT NULL DEFAULT 0 CHECK (discovered_by_customer IN (0,1));
ALTER TABLE quests ADD COLUMN discovered_by_monitor INTEGER NOT NULL DEFAULT 0 CHECK (discovered_by_monitor IN (0,1));
UPDATE quests SET discovered_by_customer=CASE WHEN source='CUSTOMER' THEN 1 ELSE 0 END,discovered_by_monitor=CASE WHEN source='MONITOR' THEN 1 ELSE 0 END;
INSERT INTO settings(key,value_json,updated_at,updated_by) VALUES('payment_containment','{"state":"CLOSED","stateVersion":1,"reasonCode":null,"probeTopupId":null}',strftime('%s','now')*1000,'MIGRATION') ON CONFLICT(key) DO NOTHING;

CREATE TRIGGER jobs_lease_integrity_insert BEFORE INSERT ON jobs WHEN (NEW.state='RUNNING' AND (NEW.lease_token IS NULL OR NEW.lease_expires_at IS NULL)) OR (NEW.state<>'RUNNING' AND (NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL)) BEGIN SELECT RAISE(ABORT, 'jobs lease/state integrity violation'); END;
CREATE TRIGGER jobs_lease_integrity_update BEFORE UPDATE ON jobs WHEN (NEW.state='RUNNING' AND (NEW.lease_token IS NULL OR NEW.lease_expires_at IS NULL)) OR (NEW.state<>'RUNNING' AND (NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL)) BEGIN SELECT RAISE(ABORT, 'jobs lease/state integrity violation'); END;
CREATE TRIGGER notifications_lease_integrity_insert BEFORE INSERT ON notifications WHEN (NEW.state='SENDING' AND (NEW.lease_token IS NULL OR NEW.lease_expires_at IS NULL OR NEW.sending_version IS NULL)) OR (NEW.state<>'SENDING' AND (NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL)) BEGIN SELECT RAISE(ABORT, 'notifications lease/state integrity violation'); END;
CREATE TRIGGER notifications_lease_integrity_update BEFORE UPDATE ON notifications WHEN (NEW.state='SENDING' AND (NEW.lease_token IS NULL OR NEW.lease_expires_at IS NULL OR NEW.sending_version IS NULL)) OR (NEW.state<>'SENDING' AND (NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL)) BEGIN SELECT RAISE(ABORT, 'notifications lease/state integrity violation'); END;
CREATE TRIGGER topups_credit_integrity_insert BEFORE INSERT ON topups WHEN NEW.status='CREDITED' AND (NEW.credited_cents<=0 OR NEW.wallet_transaction_id IS NULL OR NEW.credited_at IS NULL) BEGIN SELECT RAISE(ABORT, 'credited topup integrity violation'); END;
CREATE TRIGGER topups_credit_integrity_update BEFORE UPDATE ON topups WHEN NEW.status='CREDITED' AND (NEW.credited_cents<=0 OR NEW.wallet_transaction_id IS NULL OR NEW.credited_at IS NULL) BEGIN SELECT RAISE(ABORT, 'credited topup integrity violation'); END;
CREATE TRIGGER order_items_capture_integrity_update BEFORE UPDATE ON order_items
  WHEN NEW.state='READY_TO_CLAIM' AND OLD.state<>'READY_TO_CLAIM' AND (
    NOT EXISTS (SELECT 1 FROM settlement_evidence WHERE subject_type='ORDER_ITEM' AND subject_id=NEW.id AND outcome='CAPTURED') OR
    NOT EXISTS (SELECT 1 FROM wallet_transactions WHERE transaction_type='CAPTURE' AND reference_type='ORDER_ITEM' AND reference_id=NEW.id)
  ) BEGIN SELECT RAISE(ABORT, 'captured item integrity violation'); END;
CREATE TRIGGER order_items_release_integrity_update BEFORE UPDATE ON order_items
  WHEN NEW.state='FAILED_RELEASED' AND OLD.state<>'FAILED_RELEASED' AND (
    NOT EXISTS (SELECT 1 FROM settlement_evidence WHERE subject_type='ORDER_ITEM' AND subject_id=NEW.id AND outcome='RELEASED') OR
    NOT EXISTS (SELECT 1 FROM wallet_transactions WHERE transaction_type='RELEASE' AND reference_type='ORDER_ITEM' AND reference_id=NEW.id)
  ) BEGIN SELECT RAISE(ABORT, 'released item integrity violation'); END;
CREATE TRIGGER manual_reviews_resolution_integrity_insert BEFORE INSERT ON manual_reviews WHEN NEW.state IN ('RESOLVED_SUCCESS','RESOLVED_FAILURE') AND (NEW.decision IS NULL OR NEW.resolved_by IS NULL OR NEW.resolved_at IS NULL) BEGIN SELECT RAISE(ABORT, 'resolved review integrity violation'); END;
CREATE TRIGGER manual_reviews_resolution_integrity_update BEFORE UPDATE ON manual_reviews WHEN NEW.state IN ('RESOLVED_SUCCESS','RESOLVED_FAILURE') AND (NEW.decision IS NULL OR NEW.resolved_by IS NULL OR NEW.resolved_at IS NULL) BEGIN SELECT RAISE(ABORT, 'resolved review integrity violation'); END;
