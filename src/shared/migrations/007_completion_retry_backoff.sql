-- Objective Completion Coordinator: automatic bounded retry with exponential
-- backoff for RETRYABLE synthesis failures (transient SDK/model issues), as
-- opposed to the owner-initiated manual retry (POST .../retry-summary) which
-- remains for PERMANENT failures the owner wants to force another attempt at.
ALTER TABLE objectives ADD COLUMN completion_summary_next_retry_at INTEGER;
