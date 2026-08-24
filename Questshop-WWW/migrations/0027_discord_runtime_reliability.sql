-- Incidents are durable message projections.  A monotonic version lets a
-- resolved/reopened incident update its existing LOG_SYSTEM message safely.
ALTER TABLE incidents
  ADD COLUMN state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0);

CREATE INDEX incidents_state_version_idx ON incidents(id, state_version);

-- Interaction metrics retain their aggregate shape, but route and acknowledgement
-- data make timeout incidents diagnosable without logging customer input.
ALTER TABLE operation_metrics
  ADD COLUMN route text,
  ADD COLUMN acknowledgement text;

CREATE INDEX operation_metrics_interaction_alert_idx
  ON operation_metrics(operation, outcome, created_at DESC)
  WHERE operation IN ('PANEL_REQUEST', 'CUSTOMER_INTERACTION', 'INTERACTION_ACK');
