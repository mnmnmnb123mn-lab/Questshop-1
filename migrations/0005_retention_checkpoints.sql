CREATE UNIQUE INDEX wallet_checkpoints_boundary_idx
  ON wallet_checkpoints(discord_user_id, through_transaction_id);

