-- Claude Agent SDK session registry: maps each application conversation to
-- its SDK session so the parent SIRA session survives reconnects and API
-- restarts (resumed via options.resume). Application conversation ids and
-- SDK session ids are DIFFERENT namespaces — never conflate them.
CREATE TABLE sdk_sessions (
  conversation_id TEXT PRIMARY KEY,
  sdk_session_id TEXT,
  model TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','idle','failed','closed')),
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
) STRICT;
