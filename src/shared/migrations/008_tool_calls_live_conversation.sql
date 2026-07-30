-- Phase 2 security boundary: the live SDK conversation (parent SIRA session
-- + subagents) now routes every write/command tool through the SAME
-- dispatchTool() the worker pipeline uses (src/tools/dispatch.ts) — one
-- enforceable policy/audit boundary instead of two. A live conversational
-- tool call has no real objective/task/execution — inventing a fake one
-- just to satisfy the old NOT NULL + FK would itself be fabricated state,
-- which this project's whole design explicitly rejects. Relax tool_calls
-- to the same nullable pattern `artifacts` already uses, and add
-- conversation_id so a live call is still fully attributable.
--
-- SQLite requires a table rebuild to drop a NOT NULL/FK constraint. This
-- must NOT be done via `ALTER TABLE tool_calls RENAME TO tool_calls_old`:
-- SQLite auto-rewrites every OTHER table's REFERENCES clause that pointed
-- at the renamed-FROM name (here: approvals.tool_call_id REFERENCES
-- tool_calls) to point at the new name instead — so approvals would start
-- silently referencing the scratch table, and break the moment it's
-- dropped. PRAGMA foreign_keys=OFF doesn't help either: SQLite ignores
-- that pragma inside an active transaction, and every migration file runs
-- inside one (src/shared/db.ts migrate()). Avoid the trigger condition
-- entirely instead: build the replacement under a scratch name, drop the
-- ORIGINAL (a straight DROP does not rewrite anything), then rename the
-- scratch table INTO the original name — nothing ever pointed at the
-- scratch name, so nothing needs rewriting, and once a table named
-- tool_calls exists again, approvals' untouched "REFERENCES tool_calls"
-- text resolves correctly.
CREATE TABLE tool_calls_rebuilt (
  id TEXT PRIMARY KEY,
  execution_id TEXT REFERENCES executions(id),
  task_id TEXT,
  conversation_id TEXT REFERENCES conversations(id),
  agent_key TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '{}',
  decision TEXT NOT NULL
    CHECK (decision IN ('allowed','denied','approval_required')),
  denial_reason TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('pending_approval','running','succeeded','failed','denied','rejected')),
  result_summary TEXT,
  result_artifact_id TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;

INSERT INTO tool_calls_rebuilt (id, execution_id, task_id, conversation_id, agent_key, turn_index, tool, args_json,
                                 decision, denial_reason, status, result_summary, result_artifact_id, started_at, finished_at)
  SELECT id, execution_id, task_id, NULL, agent_key, turn_index, tool, args_json,
         decision, denial_reason, status, result_summary, result_artifact_id, started_at, finished_at
  FROM tool_calls;

DROP TABLE tool_calls;

ALTER TABLE tool_calls_rebuilt RENAME TO tool_calls;

CREATE INDEX idx_tool_calls_execution ON tool_calls(execution_id);
CREATE INDEX idx_tool_calls_conversation ON tool_calls(conversation_id);
