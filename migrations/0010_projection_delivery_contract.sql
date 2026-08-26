ALTER TABLE message_projections
  ADD COLUMN ping_sent_at timestamptz;

ALTER TABLE surfaces
  ADD COLUMN rendered_config_version bigint NOT NULL DEFAULT 0
    CHECK (rendered_config_version >= 0);

CREATE INDEX surfaces_render_refresh_idx
  ON surfaces(state, rendered_config_version)
  WHERE state IN ('ACTIVE', 'RECONCILING');
