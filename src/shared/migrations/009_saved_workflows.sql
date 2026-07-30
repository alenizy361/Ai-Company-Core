-- Saved browser/AT-SPI automation sequences, replayed locally without model
-- involvement per step (src/desktop-bridge/workflows/). A real table, not
-- the scalar settings key/value store — this needs per-row CRUD, an index
-- on (org_id, name), and safe concurrent writes, matching how every other
-- listable/structured entity in this schema (artifacts, tool_calls,
-- approvals) already gets its own table rather than a JSON blob under
-- settings. kind is restricted to browser/atspi — a saved workflow may
-- never contain a raw desktop_click(x,y) step; absolute screen coordinates
-- are exactly the fragile state this whole feature exists to move away
-- from (enforced at save time in workflows/store.ts, not just here).
CREATE TABLE saved_workflows (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('browser', 'atspi')),
  signature_json TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  created_by_agent_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_run_at INTEGER,
  run_count INTEGER NOT NULL DEFAULT 0,
  last_result_json TEXT,
  UNIQUE (org_id, name)
) STRICT;
