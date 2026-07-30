-- Background Objective Completion Bridge: a background objective (worker
-- pipeline: plan -> tasks -> executions -> handoffs -> verification) that
-- was opened FROM a conversation must return its result to that SAME
-- persistent SIRA conversation when it finishes — not just a generic
-- "Objective completed" activity notification. objectives.conversation_id
-- already exists (001_init.sql); this adds the fields needed to trigger,
-- track, and make idempotent the synthesis step that produces SIRA's real
-- spoken/written answer.
--
-- completion_summary_status is NULL for objectives with no conversation_id
-- (e.g. autopilot cycles — nothing to bridge back to) or before the
-- objective reaches a terminal state. Once terminal AND conversation-linked,
-- it moves pending -> generating -> completed|failed. 'generating' rows
-- older than the sweep's staleness window are reclaimed (crashed/restarted
-- API process), and a 'pending'/'generating' claim is won with a single
-- conditional UPDATE (same pattern as prompt baseline activation).
ALTER TABLE objectives ADD COLUMN originating_message_id TEXT;
ALTER TABLE objectives ADD COLUMN completed_at INTEGER;
ALTER TABLE objectives ADD COLUMN completion_summary_status TEXT
  CHECK (completion_summary_status IS NULL OR completion_summary_status IN ('pending', 'generating', 'completed', 'failed'));
ALTER TABLE objectives ADD COLUMN completion_summary_message_id TEXT;
ALTER TABLE objectives ADD COLUMN completion_summary_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE objectives ADD COLUMN completion_summary_error TEXT;
ALTER TABLE objectives ADD COLUMN completion_summary_started_at INTEGER;
ALTER TABLE objectives ADD COLUMN summarized_at INTEGER;

CREATE INDEX idx_objectives_completion_pending ON objectives(completion_summary_status);
