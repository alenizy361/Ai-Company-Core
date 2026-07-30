-- Runtime owner settings (key/value): autopilot switch, standing directive,
-- cycle bookkeeping. Server-side so every process (API + worker) sees the
-- same truth and it survives restarts.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
