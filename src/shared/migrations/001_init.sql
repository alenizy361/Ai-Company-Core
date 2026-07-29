-- RABIT OS schema v1. All timestamps are epoch milliseconds (INTEGER).
-- Agent runtime status is never stored: it is derived from tasks/executions/worker heartbeats.

CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  key TEXT NOT NULL UNIQUE,
  short TEXT NOT NULL,
  name_en TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  color TEXT NOT NULL,
  reports_to TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'not_configured'
    CHECK (lifecycle IN ('not_configured','inactive','active')),
  active_prompt_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('core','agent','task')),
  key TEXT NOT NULL,
  UNIQUE (scope, key)
) STRICT;

CREATE TABLE prompt_versions (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES prompts(id),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','active','rolled_back','archived')),
  evaluation_score REAL,
  rollback_of TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (prompt_id, version)
) STRICT;
CREATE INDEX idx_prompt_versions_hash ON prompt_versions(content_hash);

CREATE TABLE objectives (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'owner',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','planning','plan_proposed','in_progress','completed','failed','cancelled')),
  conversation_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL REFERENCES objectives(id),
  version INTEGER NOT NULL,
  model_request_id TEXT,
  raw_json TEXT NOT NULL,
  reply TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','rejected','confirmed','superseded')),
  validation_errors TEXT,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  UNIQUE (objective_id, version)
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  objective_id TEXT NOT NULL REFERENCES objectives(id),
  step_id TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  required_inputs TEXT NOT NULL DEFAULT '[]',
  expected_artifacts TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  verification TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','waiting_for_dependency','blocked','running','waiting_for_tool',
                      'waiting_for_approval','verifying','failed','cancelled','completed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  not_before INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  lease_expires_at INTEGER,
  blocker TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (plan_id, step_id)
) STRICT;
CREATE INDEX idx_tasks_claim ON tasks(status, not_before);
CREATE INDEX idx_tasks_objective ON tasks(objective_id);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on_task_id)
) STRICT;
CREATE INDEX idx_task_deps_reverse ON task_dependencies(depends_on_task_id);

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_key TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  prompt_version_id TEXT,
  core_bundle_hash TEXT,
  adapter TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','waiting_for_tool','waiting_for_approval','verifying',
                      'completed','failed','cancelled','abandoned')),
  worker_id TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  turns_used INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;
CREATE INDEX idx_executions_task ON executions(task_id);
CREATE INDEX idx_executions_lease ON executions(status, lease_expires_at);

-- The SSE source of truth. seq is the SSE event id; clients resume with Last-Event-ID.
CREATE TABLE execution_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  execution_id TEXT,
  task_id TEXT,
  agent_key TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_events_execution ON execution_events(execution_id);
CREATE INDEX idx_events_task ON execution_events(task_id);
CREATE INDEX idx_events_type_time ON execution_events(type, created_at);

CREATE TABLE model_requests (
  id TEXT PRIMARY KEY,
  execution_id TEXT,
  purpose TEXT NOT NULL DEFAULT 'execution'
    CHECK (purpose IN ('execution','planning','converse','eval')),
  adapter TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  turn_index INTEGER NOT NULL DEFAULT 0,
  prompt_chars INTEGER NOT NULL DEFAULT 0,
  response_text TEXT NOT NULL DEFAULT '',
  parse_status TEXT NOT NULL DEFAULT 'ok'
    CHECK (parse_status IN ('ok','parse_error','adapter_error')),
  error TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_model_requests_execution ON model_requests(execution_id);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  task_id TEXT NOT NULL,
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
CREATE INDEX idx_tool_calls_execution ON tool_calls(execution_id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  tool_call_id TEXT REFERENCES tool_calls(id),
  execution_id TEXT,
  task_id TEXT,
  summary TEXT NOT NULL,
  cost_note TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','expired')),
  reason TEXT,
  requested_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  decided_via TEXT CHECK (decided_via IN ('ui','voice','api'))
) STRICT;
CREATE INDEX idx_approvals_status ON approvals(status);

-- Artifact bytes live under var/artifacts/<id>; rows are metadata. Agents exchange references.
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  task_id TEXT,
  execution_id TEXT,
  agent_key TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'file',
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_artifacts_task ON artifacts(task_id);

CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  from_task_id TEXT NOT NULL,
  to_task_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  artifact_ids TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL,
  assumptions TEXT NOT NULL DEFAULT '[]',
  unresolved_issues TEXT NOT NULL DEFAULT '[]',
  next_action TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending','artifacts_confirmed','artifacts_missing'))
) STRICT;
CREATE INDEX idx_handoffs_to_task ON handoffs(to_task_id);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  agent_key TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('company','agent','objective')),
  objective_id TEXT,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  source_execution_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_memories_lookup ON memories(scope, agent_key, objective_id);

CREATE TABLE eval_runs (
  id TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL,
  prompt_version_id TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('mechanical','model')),
  adapter TEXT NOT NULL,
  total INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  score REAL NOT NULL,
  baseline_score REAL,
  verdict TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE eval_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES eval_runs(id),
  case_id TEXT NOT NULL,
  category TEXT NOT NULL,
  passed INTEGER NOT NULL,
  score REAL NOT NULL,
  details TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX idx_eval_results_run ON eval_results(run_id);

-- Max-plan reality: capacity is tracked in tokens per quota window, not dollars.
CREATE TABLE usage_windows (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('session_5h','weekly')),
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE (kind, window_start)
) STRICT;

CREATE TABLE workers (
  id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_heartbeat_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online','draining','stopped'))
) STRICT;

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_audit_time ON audit_logs(created_at);

-- ============ voice / conversation layer ============

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  modality TEXT NOT NULL DEFAULT 'text' CHECK (modality IN ('voice','text')),
  lang TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  route TEXT,
  interrupted_at_char INTEGER,
  model_request_id TEXT,
  objective_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE voice_sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  client_kind TEXT NOT NULL DEFAULT 'web',
  availability_mode TEXT NOT NULL DEFAULT 'push_to_talk',
  token_hash TEXT,
  token_expires_at INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
) STRICT;

CREATE TABLE voice_state_transitions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  source TEXT NOT NULL,
  valid INTEGER NOT NULL DEFAULT 1,
  ts INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_voice_transitions_session ON voice_state_transitions(session_id);

CREATE TABLE voice_metrics (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  metric TEXT NOT NULL,
  value_ms REAL NOT NULL,
  ts INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_voice_metrics_session ON voice_metrics(session_id, metric);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  delivered_via TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  read_at INTEGER
) STRICT;
CREATE INDEX idx_notifications_unread ON notifications(read_at, created_at);
