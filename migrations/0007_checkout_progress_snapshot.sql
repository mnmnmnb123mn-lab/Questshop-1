ALTER TABLE checkout_quest_options
  ADD COLUMN progress_actual numeric(7,3) NOT NULL DEFAULT 0
  CHECK (progress_actual >= 0 AND progress_actual <= 100);

