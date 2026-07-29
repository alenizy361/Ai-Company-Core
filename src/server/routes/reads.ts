// Read-only inspection endpoints: agents, objectives, tasks, executions,
// tool calls, artifacts, approvals, audit, usage. All plain SELECTs.
import { readFileSync, existsSync } from 'node:fs';
import type { Db } from '../../shared/db.ts';
import type { Router } from '../router.ts';
import { json, errorJson } from '../router.ts';

function parseJsonCols<T extends Record<string, unknown>>(row: T, cols: string[]): T {
  const out: Record<string, unknown> = { ...row };
  for (const col of cols) {
    if (typeof out[col] === 'string') {
      try {
        out[col] = JSON.parse(out[col] as string);
      } catch {
        /* leave as string */
      }
    }
  }
  return out as T;
}

export function registerReadRoutes(router: Router, db: Db): void {
  router.get('/api/agents', ({ res }) => {
    json(res, 200, db.all('SELECT * FROM agents ORDER BY key'));
  });

  router.get('/api/agents/:key', ({ res, params }) => {
    const agent = db.get('SELECT * FROM agents WHERE key = ?', params.key);
    if (!agent) return errorJson(res, 404, 'NOT_FOUND', 'unknown agent');
    const prompt = db.get<{ id: string }>(`SELECT id FROM prompts WHERE scope = 'agent' AND key = ?`, params.key);
    const versions = prompt
      ? db.all(
          `SELECT id, version, content_hash, status, evaluation_score, rollback_of, created_at, updated_at
           FROM prompt_versions WHERE prompt_id = ? ORDER BY version DESC`,
          prompt.id,
        )
      : [];
    const recentTasks = db.all(
      `SELECT id, title, status, objective_id, updated_at FROM tasks
       WHERE agent_key = ? ORDER BY updated_at DESC LIMIT 25`,
      params.key,
    );
    const evalRuns = db.all(
      `SELECT * FROM eval_runs WHERE agent_key = ? ORDER BY created_at DESC LIMIT 10`,
      params.key,
    );
    json(res, 200, { agent, promptVersions: versions, recentTasks, evalRuns });
  });

  router.get('/api/objectives', ({ res }) => {
    json(res, 200, db.all('SELECT * FROM objectives ORDER BY created_at DESC LIMIT 100'));
  });

  router.get('/api/objectives/:id', ({ res, params }) => {
    const objective = db.get('SELECT * FROM objectives WHERE id = ?', params.id);
    if (!objective) return errorJson(res, 404, 'NOT_FOUND', 'unknown objective');
    const plans = db.all<Record<string, unknown>>(
      'SELECT * FROM plans WHERE objective_id = ? ORDER BY version DESC',
      params.id,
    ).map((p) => parseJsonCols(p, ['raw_json', 'validation_errors']));
    const tasks = db.all<Record<string, unknown>>(
      'SELECT * FROM tasks WHERE objective_id = ? ORDER BY created_at',
      params.id,
    ).map((t) => parseJsonCols(t, ['required_inputs', 'expected_artifacts', 'acceptance_criteria', 'verification']));
    const deps = db.all(
      `SELECT td.task_id, td.depends_on_task_id FROM task_dependencies td
       JOIN tasks t ON t.id = td.task_id WHERE t.objective_id = ?`,
      params.id,
    );
    json(res, 200, { objective, plans, tasks, dependencies: deps });
  });

  router.get('/api/tasks/:id', ({ res, params }) => {
    const task = db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', params.id);
    if (!task) return errorJson(res, 404, 'NOT_FOUND', 'unknown task');
    const executions = db.all('SELECT * FROM executions WHERE task_id = ? ORDER BY started_at', params.id);
    const artifacts = db.all('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at', params.id);
    const dependsOn = db.all(
      `SELECT t.id, t.step_id, t.title, t.status FROM task_dependencies td
       JOIN tasks t ON t.id = td.depends_on_task_id WHERE td.task_id = ?`,
      params.id,
    );
    const dependents = db.all(
      `SELECT t.id, t.step_id, t.title, t.status FROM task_dependencies td
       JOIN tasks t ON t.id = td.task_id WHERE td.depends_on_task_id = ?`,
      params.id,
    );
    const handoffs = db.all<Record<string, unknown>>(
      'SELECT * FROM handoffs WHERE to_task_id = ? OR from_task_id = ? ORDER BY created_at',
      params.id,
      params.id,
    ).map((h) => parseJsonCols(h, ['artifact_ids', 'assumptions', 'unresolved_issues', 'acceptance_criteria']));
    const events = db.all(
      'SELECT * FROM execution_events WHERE task_id = ? ORDER BY seq DESC LIMIT 200',
      params.id,
    );
    json(res, 200, {
      task: parseJsonCols(task, ['required_inputs', 'expected_artifacts', 'acceptance_criteria', 'verification']),
      executions,
      artifacts,
      dependsOn,
      dependents,
      handoffs,
      events,
    });
  });

  router.get('/api/executions/:id', ({ res, params }) => {
    const execution = db.get('SELECT * FROM executions WHERE id = ?', params.id);
    if (!execution) return errorJson(res, 404, 'NOT_FOUND', 'unknown execution');
    const events = db.all('SELECT * FROM execution_events WHERE execution_id = ? ORDER BY seq', params.id);
    const modelRequests = db.all(
      `SELECT id, adapter, model, turn_index, prompt_chars, parse_status, error, input_tokens, output_tokens,
              duration_ms, created_at FROM model_requests WHERE execution_id = ? ORDER BY turn_index`,
      params.id,
    );
    const toolCalls = db.all('SELECT * FROM tool_calls WHERE execution_id = ? ORDER BY started_at', params.id);
    json(res, 200, { execution, events, modelRequests, toolCalls });
  });

  router.get('/api/tool-calls/:id', ({ res, params }) => {
    const call = db.get<Record<string, unknown>>('SELECT * FROM tool_calls WHERE id = ?', params.id);
    if (!call) return errorJson(res, 404, 'NOT_FOUND', 'unknown tool call');
    const approval = db.get('SELECT * FROM approvals WHERE tool_call_id = ?', params.id);
    json(res, 200, { toolCall: parseJsonCols(call, ['args_json']), approval });
  });

  router.get('/api/artifacts/:id', ({ res, params }) => {
    const artifact = db.get<Record<string, unknown>>('SELECT * FROM artifacts WHERE id = ?', params.id);
    if (!artifact) return errorJson(res, 404, 'NOT_FOUND', 'unknown artifact');
    json(res, 200, parseJsonCols(artifact, ['meta']));
  });

  router.get('/api/artifacts/:id/content', ({ res, params }) => {
    const artifact = db.get<{ path: string; name: string }>('SELECT path, name FROM artifacts WHERE id = ?', params.id);
    if (!artifact) return errorJson(res, 404, 'NOT_FOUND', 'unknown artifact');
    if (!existsSync(artifact.path)) return errorJson(res, 410, 'GONE', 'artifact bytes missing from storage');
    const content = readFileSync(artifact.path);
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `inline; filename="${artifact.name.replace(/[^\w.-]/g, '_')}"`,
    });
    res.end(content);
  });

  router.get('/api/approvals', ({ res, query }) => {
    const status = query.get('status') ?? 'pending';
    json(res, 200, db.all('SELECT * FROM approvals WHERE status = ? ORDER BY requested_at DESC LIMIT 100', status));
  });

  router.get('/api/audit', ({ res, query }) => {
    const limit = Math.min(Number(query.get('limit') ?? 100), 500);
    json(res, 200, db.all('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?', limit));
  });

  router.get('/api/usage', ({ res }) => {
    json(res, 200, {
      windows: db.all('SELECT * FROM usage_windows ORDER BY window_start DESC LIMIT 20'),
      byAgent: db.all(
        `SELECT agent_key, COUNT(*) AS executions, SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens, SUM(turns_used) AS turns
         FROM executions GROUP BY agent_key ORDER BY input_tokens DESC`,
      ),
    });
  });

  router.get('/api/failures', ({ res }) => {
    json(res, 200, {
      failedTasks: db.all(
        `SELECT id, title, agent_key, status, attempt_count, max_attempts, blocker, updated_at
         FROM tasks WHERE status IN ('failed','blocked') ORDER BY updated_at DESC LIMIT 100`,
      ),
      failedExecutions: db.all(
        `SELECT id, task_id, agent_key, status, failure_reason, started_at, finished_at
         FROM executions WHERE status IN ('failed','abandoned') ORDER BY started_at DESC LIMIT 100`,
      ),
    });
  });
}
