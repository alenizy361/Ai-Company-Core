// Prompt promotion / rollback. A candidate agent prompt version becomes
// active ONLY when its eval run passes the gate (mechanical = 100%, and not
// below the previous baseline). First promotion also activates the agent on
// the board. Rollback restores the prior version; history is never deleted.
import type { Db } from '../shared/db.ts';
import { emitEvent, audit } from '../shared/events.ts';
import { loadSystemConfig } from '../shared/config.ts';
import type { EvalRunSummary } from './runner.ts';

export interface PromotionDecision {
  promoted: boolean;
  reason: string;
  agentActivated?: boolean;
}

export function promoteIfPassing(db: Db, summary: EvalRunSummary): PromotionDecision {
  const cfg = loadSystemConfig();
  if (summary.score !== 100) {
    return { promoted: false, reason: `mechanical gate requires 100%; scored ${summary.score}% (${summary.passed}/${summary.total})` };
  }
  const previous = db.get<{ score: number }>(
    `SELECT score FROM eval_runs WHERE agent_key = ? AND tier = 'mechanical' AND id != ? ORDER BY created_at DESC LIMIT 1`,
    summary.agentKey, summary.runId,
  );
  if (previous && summary.score < previous.score) {
    return { promoted: false, reason: `score ${summary.score} below baseline ${previous.score}` };
  }

  const now = Date.now();
  const agent = db.get<{ id: string; lifecycle: string; active_prompt_version_id: string | null }>(
    'SELECT id, lifecycle, active_prompt_version_id FROM agents WHERE key = ?', summary.agentKey,
  );
  if (!agent) return { promoted: false, reason: 'agent missing' };

  const firstActivation = agent.lifecycle !== 'active';
  db.transaction(() => {
    if (agent.active_prompt_version_id && agent.active_prompt_version_id !== summary.promptVersionId) {
      db.run(`UPDATE prompt_versions SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active'`,
        now, agent.active_prompt_version_id);
    }
    db.run(`UPDATE prompt_versions SET status = 'active', evaluation_score = ?, updated_at = ? WHERE id = ?`,
      summary.score, now, summary.promptVersionId);
    db.run(`UPDATE agents SET lifecycle = 'active', active_prompt_version_id = ?, updated_at = ? WHERE key = ?`,
      summary.promptVersionId, now, summary.agentKey);
    emitEvent(db, {
      type: 'prompt.promoted', orgId: cfg.orgId, agentKey: summary.agentKey,
      payload: { versionId: summary.promptVersionId, score: summary.score, runId: summary.runId, firstActivation },
    });
    audit(db, cfg.orgId, 'eval-harness', 'prompt.promote', 'prompt_version', summary.promptVersionId,
      { agentKey: summary.agentKey, score: summary.score, runId: summary.runId });
  });
  return { promoted: true, reason: `score ${summary.score}%`, agentActivated: firstActivation };
}

export function rollbackAgentPrompt(db: Db, agentKey: string, actor: string): { ok: boolean; reason: string } {
  const cfg = loadSystemConfig();
  const agent = db.get<{ active_prompt_version_id: string | null }>(
    'SELECT active_prompt_version_id FROM agents WHERE key = ?', agentKey,
  );
  if (!agent?.active_prompt_version_id) return { ok: false, reason: 'no active version to roll back' };

  const current = db.get<{ id: string; prompt_id: string; version: number }>(
    'SELECT id, prompt_id, version FROM prompt_versions WHERE id = ?', agent.active_prompt_version_id,
  );
  if (!current) return { ok: false, reason: 'active version row missing' };

  const previous = db.get<{ id: string; version: number }>(
    `SELECT id, version FROM prompt_versions WHERE prompt_id = ? AND version < ? AND status IN ('archived','active')
     ORDER BY version DESC LIMIT 1`,
    current.prompt_id, current.version,
  );
  if (!previous) return { ok: false, reason: 'no earlier version exists' };

  const now = Date.now();
  db.transaction(() => {
    db.run(`UPDATE prompt_versions SET status = 'rolled_back', rollback_of = ?, updated_at = ? WHERE id = ?`,
      previous.id, now, current.id);
    db.run(`UPDATE prompt_versions SET status = 'active', updated_at = ? WHERE id = ?`, now, previous.id);
    db.run(`UPDATE agents SET active_prompt_version_id = ?, updated_at = ? WHERE key = ?`, previous.id, now, agentKey);
    emitEvent(db, {
      type: 'prompt.rolled_back', orgId: cfg.orgId, agentKey,
      payload: { from: current.id, to: previous.id, fromVersion: current.version, toVersion: previous.version },
    });
    audit(db, cfg.orgId, actor, 'prompt.rollback', 'prompt_version', current.id, { agentKey, restored: previous.id });
  });
  return { ok: true, reason: `rolled back v${current.version} -> v${previous.version}` };
}
