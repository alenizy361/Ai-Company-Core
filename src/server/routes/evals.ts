// Prompt & evaluation management routes: version history, eval runs/results,
// owner-triggered rollback. Promotion happens through the eval CLI/harness —
// there is deliberately no HTTP endpoint that activates a prompt without an
// eval run behind it.
import type { Db } from '../../shared/db.ts';
import type { Router } from '../router.ts';
import { json, errorJson } from '../router.ts';
import { rollbackAgentPrompt } from '../../evals/promote.ts';

export function registerEvalRoutes(router: Router, db: Db): void {
  router.get('/api/prompts', ({ res }) => {
    const rows = db.all(
      `SELECT p.scope, p.key, pv.id AS version_id, pv.version, pv.status, pv.content_hash,
              pv.evaluation_score, pv.created_at, pv.updated_at,
              (SELECT a.key FROM agents a WHERE a.active_prompt_version_id = pv.id) AS active_for
       FROM prompt_versions pv JOIN prompts p ON p.id = pv.prompt_id
       ORDER BY p.scope, p.key, pv.version DESC`,
    );
    json(res, 200, rows);
  });

  router.get('/api/prompts/:scope/:key', ({ res, params }) => {
    const rows = db.all(
      `SELECT pv.* FROM prompt_versions pv JOIN prompts p ON p.id = pv.prompt_id
       WHERE p.scope = ? AND p.key = ? ORDER BY pv.version DESC`,
      params.scope, params.key,
    );
    if (!rows.length) return errorJson(res, 404, 'NOT_FOUND', 'unknown prompt');
    json(res, 200, rows);
  });

  router.post('/api/prompts/agents/:key/rollback', ({ res, params, body }) => {
    const actor = (body as { actor?: string } | undefined)?.actor ?? 'owner';
    const result = rollbackAgentPrompt(db, params.key, actor);
    json(res, result.ok ? 200 : 409, result);
  });

  router.get('/api/evals', ({ res }) => {
    json(res, 200, db.all('SELECT * FROM eval_runs ORDER BY created_at DESC LIMIT 100'));
  });

  router.get('/api/evals/:runId', ({ res, params }) => {
    const run = db.get('SELECT * FROM eval_runs WHERE id = ?', params.runId);
    if (!run) return errorJson(res, 404, 'NOT_FOUND', 'unknown eval run');
    const results = db.all<Record<string, unknown>>('SELECT * FROM eval_results WHERE run_id = ?', params.runId)
      .map((r) => ({ ...r, details: JSON.parse((r.details as string) || '[]') }));
    json(res, 200, { run, results });
  });
}
