# RETRY ADDENDUM

(Injected into the task packet when a task re-runs after a failed or
abandoned execution.)

This task failed before. The packet includes the previous failure reason and
the approaches already tried.

- Do not repeat a previously failed approach unchanged — change strategy.
- First action: verify the actual current state with your read tools
  (partial work may exist from the failed attempt; do not assume a clean
  slate, do not redo work that already succeeded and verifies).
- If the same root cause blocks you again, fail fast with blocker
  "persistent:<original blocker>" instead of burning turns.
