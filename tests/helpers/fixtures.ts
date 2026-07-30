// Shared test fixtures: throwaway env (db + workspace) with seeded org,
// agents, prompts; helpers to activate agents and create confirmed plans
// without a model call. Uses the same production code paths everywhere.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../src/shared/db.ts';
import { loadPaths, loadSystemConfig, type Paths, type SystemConfig } from '../../src/shared/config.ts';
import { seedOrgAndAgents } from '../../src/shared/seed.ts';
import { seedPromptsFromDisk } from '../../src/promptreg/registry.ts';
import { ulid } from '../../src/shared/ids.ts';
import { confirmPlan } from '../../src/planning/plan-service.ts';

export interface TestEnv {
  dir: string;
  db: Db;
  paths: Paths;
  cfg: SystemConfig;
  cleanup: () => void;
}

export function makeEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'sira-test-'));
  const prevVar = process.env.SIRA_VAR;
  const prevDb = process.env.SIRA_DB;
  process.env.SIRA_VAR = dir;
  delete process.env.SIRA_DB;
  const paths = loadPaths();
  const cfg = loadSystemConfig();
  const db = openDb(paths.dbPath, paths.migrationsDir);
  seedOrgAndAgents(db);
  seedPromptsFromDisk(db, paths.promptsDir);
  return {
    dir, db, paths, cfg,
    cleanup: () => {
      try { db.close(); } catch { /* closed */ }
      rmSync(dir, { recursive: true, force: true });
      if (prevVar !== undefined) process.env.SIRA_VAR = prevVar; else delete process.env.SIRA_VAR;
      if (prevDb !== undefined) process.env.SIRA_DB = prevDb;
    },
  };
}

export function activateAgents(db: Db, keys: string[]): void {
  for (const key of keys) {
    const version = db.get<{ id: string }>(
      `SELECT pv.id FROM prompt_versions pv JOIN prompts p ON p.id = pv.prompt_id
       WHERE p.scope = 'agent' AND p.key = ? ORDER BY pv.version DESC LIMIT 1`, key,
    );
    if (!version) throw new Error(`no prompt for ${key}`);
    db.run(`UPDATE prompt_versions SET status = 'active' WHERE id = ?`, version.id);
    db.run(`UPDATE agents SET lifecycle = 'active', active_prompt_version_id = ?, updated_at = ? WHERE key = ?`,
      version.id, Date.now(), key);
  }
}

export interface StepFixture {
  step_id: string;
  agent: string;
  title?: string;
  spec: string;
  depends_on?: string[];
  expected_artifacts?: string[];
  acceptance_criteria?: string[];
  verification?: unknown[];
}

export function createConfirmedPlan(
  env: TestEnv, title: string, steps: StepFixture[], conversationId: string | null = null,
): { objectiveId: string; planId: string; taskIds: string[] } {
  const now = Date.now();
  const objectiveId = ulid('obj');
  env.db.run(`INSERT INTO objectives (id, org_id, title, status, conversation_id, created_at, updated_at) VALUES (?, ?, ?, 'plan_proposed', ?, ?, ?)`,
    objectiveId, env.cfg.orgId, title, conversationId, now, now);
  const planId = ulid('pln');
  const parsed = {
    reply: title,
    team: [...new Set(steps.map((s) => s.agent))],
    plan: steps.map((s) => ({
      step_id: s.step_id,
      agent: s.agent,
      title: s.title ?? s.step_id,
      spec: s.spec,
      depends_on: s.depends_on ?? [],
      required_inputs: [],
      expected_artifacts: s.expected_artifacts ?? [],
      acceptance_criteria: s.acceptance_criteria ?? ['deliverable exists'],
      verification: s.verification ?? [],
      priority: 3,
      status: 'queued' as const,
    })),
  };
  env.db.run(`INSERT INTO plans (id, objective_id, version, raw_json, reply, status, created_at) VALUES (?, ?, 1, ?, ?, 'proposed', ?)`,
    planId, objectiveId, JSON.stringify(parsed), title, now);
  const { taskIds } = confirmPlan(env.db, planId, 'test');
  return { objectiveId, planId, taskIds };
}

export const toolTurn = (tool: string, args: Record<string, unknown>, reason = 'test'): string =>
  JSON.stringify({ action: 'tool', tool, args, reason });
export const completeTurn = (summary: string, artifacts: string[] = []): string =>
  JSON.stringify({ action: 'complete', summary, artifacts, self_check: {}, assumptions: [], unresolved: [], next_action: '' });
export const failTurn = (reason: string, blockers: string[] = []): string =>
  JSON.stringify({ action: 'fail', reason, blockers, tried: [] });

export const MOCK = (turns: string[]): string => `MOCK_SCRIPT:${JSON.stringify(turns)}END_MOCK_SCRIPT`;
