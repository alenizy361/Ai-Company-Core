// Eval runner: executes each case through the REAL worker machinery (claim,
// dispatch, permission enforcement, verification, handoffs) against a
// throwaway database + workspace, with the mock adapter replaying the case
// script. Deterministic by construction. Results are recorded in the MAIN
// database (eval_runs / eval_results) for the promotion gate and the UI.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type Db } from '../shared/db.ts';
import { loadPermissions, loadSystemConfig, type Paths } from '../shared/config.ts';
import { seedOrgAndAgents } from '../shared/seed.ts';
import { seedPromptsFromDisk } from '../promptreg/registry.ts';
import { ulid } from '../shared/ids.ts';
import { MockAdapter } from '../adapters/mock.ts';
import { claimNextTask } from '../worker/claims.ts';
import { runExecution } from '../worker/execute.ts';
import { storeArtifact } from '../tools/impl/artifacts.ts';
import type { EvalCase } from './cases.ts';

export interface CaseResult {
  caseId: string;
  category: string;
  passed: boolean;
  weight: number;
  details: string[];
}

export interface EvalRunSummary {
  runId: string;
  agentKey: string;
  promptVersionId: string;
  total: number;
  passed: number;
  score: number; // weighted 0..100
  results: CaseResult[];
}

async function runCase(agentKey: string, evalCase: EvalCase, scratchRoot: string, promptsDir: string): Promise<CaseResult> {
  const caseDir = join(scratchRoot, evalCase.id);
  rmSync(caseDir, { recursive: true, force: true });
  mkdirSync(caseDir, { recursive: true });

  const prevVar = process.env.SIRA_VAR;
  const prevDb = process.env.SIRA_DB;
  process.env.SIRA_VAR = caseDir;
  delete process.env.SIRA_DB;

  const details: string[] = [];
  try {
    const { loadPaths } = await import('../shared/config.ts');
    const paths: Paths = loadPaths();
    const cfg = loadSystemConfig();
    const db = openDb(paths.dbPath, paths.migrationsDir);
    seedOrgAndAgents(db);
    seedPromptsFromDisk(db, promptsDir);

    // Activate the agent under test with its latest prompt version.
    const version = db.get<{ id: string }>(
      `SELECT pv.id FROM prompt_versions pv JOIN prompts p ON p.id = pv.prompt_id
       WHERE p.scope = 'agent' AND p.key = ? ORDER BY pv.version DESC LIMIT 1`, agentKey,
    );
    if (!version) throw new Error(`no prompt version for ${agentKey}`);
    db.run(`UPDATE prompt_versions SET status = 'active' WHERE id = ?`, version.id);
    db.run(`UPDATE agents SET lifecycle = 'active', active_prompt_version_id = ?, updated_at = ? WHERE key = ?`,
      version.id, Date.now(), agentKey);

    // Objective + confirmed single-task plan.
    const now = Date.now();
    const objectiveId = ulid('obj');
    db.run(`INSERT INTO objectives (id, org_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'in_progress', ?, ?)`,
      objectiveId, cfg.orgId, `eval: ${evalCase.id}`, now, now);
    const planId = ulid('pln');
    db.run(`INSERT INTO plans (id, objective_id, version, raw_json, reply, status, created_at) VALUES (?, ?, 1, '{}', '', 'confirmed', ?)`,
      planId, objectiveId, now);
    const taskId = ulid('tsk');
    db.run(
      `INSERT INTO tasks (id, plan_id, objective_id, step_id, agent_key, title, spec, required_inputs, expected_artifacts,
         acceptance_criteria, verification, priority, status, max_attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'eval-step', ?, ?, ?, '[]', ?, ?, ?, 1, 'queued', 1, ?, ?)`,
      taskId, planId, objectiveId, agentKey, evalCase.task.title, evalCase.task.spec,
      JSON.stringify(evalCase.task.expected_artifacts), JSON.stringify(evalCase.task.acceptance_criteria),
      JSON.stringify(evalCase.task.verification), now, now,
    );

    // Seed a predecessor artifact + handoff when the case requires it.
    if (evalCase.seedInputArtifact) {
      const predTaskId = ulid('tsk');
      db.run(
        `INSERT INTO tasks (id, plan_id, objective_id, step_id, agent_key, title, spec, priority, status, max_attempts, created_at, updated_at)
         VALUES (?, ?, ?, 'eval-predecessor', 'pm', 'predecessor', 'predecessor spec for eval fixtures (complete).', 1, 'completed', 1, ?, ?)`,
        predTaskId, planId, objectiveId, now - 1000, now - 1000,
      );
      const stored = storeArtifact(
        { db, artifactsDir: paths.artifactsDir, orgId: cfg.orgId },
        { taskId: predTaskId, executionId: null, agentKey: 'pm', name: evalCase.seedInputArtifact.name, kind: 'document', content: evalCase.seedInputArtifact.content },
      );
      db.run('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)', taskId, predTaskId);
      db.run(
        `INSERT INTO handoffs (id, from_task_id, to_task_id, from_agent, to_agent, execution_id, artifact_ids, summary, next_action, created_at, verified_at, verification_status)
         VALUES (?, ?, ?, 'pm', ?, 'exe_seed', ?, 'Predecessor deliverable ready.', 'Consume the artifact.', ?, ?, 'artifacts_confirmed')`,
        ulid('hnd'), predTaskId, taskId, agentKey, JSON.stringify([stored.id]), now - 900, now - 900,
      );
    }

    const task = claimNextTask(db, cfg, 'eval-worker');
    if (!task) throw new Error('claim returned no task');
    const outcome = await runExecution(db, cfg, paths, new MockAdapter(evalCase.script), task, 'eval-worker');

    // ------- assertions against persisted truth -------
    const finalTask = db.get<{ status: string; blocker: string | null }>('SELECT status, blocker FROM tasks WHERE id = ?', taskId);
    const calls = db.all<{ tool: string; decision: string; status: string }>(
      'SELECT tool, decision, status FROM tool_calls WHERE task_id = ?', taskId,
    );
    // "must call" = the tool was legitimately dispatched (an intentionally
    // failing call — e.g. reading a missing artifact in recovery cases —
    // still counts as called). Denied calls never count.
    const calledOk = new Set(calls.filter((c) => c.decision === 'allowed').map((c) => c.tool));
    const deniedCalls = calls.filter((c) => c.decision === 'denied');
    const expect = evalCase.expect;
    let passed = true;
    const check = (ok: boolean, msg: string): void => {
      if (!ok) passed = false;
      details.push(`${ok ? 'PASS' : 'FAIL'}: ${msg}`);
    };

    check(finalTask?.status === expect.finalTaskStatus,
      `final task status ${finalTask?.status} (expected ${expect.finalTaskStatus}; outcome=${outcome}${finalTask?.blocker ? `; blocker=${finalTask.blocker}` : ''})`);
    for (const tool of expect.mustCallTools ?? []) check(calledOk.has(tool), `tool ${tool} was called successfully`);
    for (const tool of expect.mustNotCallTools ?? []) {
      check(!calls.some((c) => c.tool === tool && c.status === 'succeeded'), `tool ${tool} was never executed`);
    }
    if (expect.deniedCallRecorded) {
      check(deniedCalls.length > 0, `a denied tool call was recorded (${deniedCalls.map((c) => c.tool).join(',') || 'none'})`);
    }
    for (const name of expect.artifactExists ?? []) {
      check(!!db.get('SELECT id FROM artifacts WHERE task_id = ? AND name = ?', taskId, name), `artifact ${name} exists`);
    }
    for (const name of expect.artifactAbsent ?? []) {
      check(!db.get('SELECT id FROM artifacts WHERE task_id = ? AND name = ?', taskId, name), `artifact ${name} was NOT fabricated`);
    }
    if (expect.blockersInclude) {
      const blocker = finalTask?.blocker ?? '';
      for (const needle of expect.blockersInclude) check(blocker.includes(needle), `blocker mentions ${needle} (got "${blocker}")`);
    }

    db.close();
    return { caseId: evalCase.id, category: evalCase.category, passed, weight: evalCase.weight, details };
  } catch (err) {
    details.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return { caseId: evalCase.id, category: evalCase.category, passed: false, weight: evalCase.weight, details };
  } finally {
    if (prevVar !== undefined) process.env.SIRA_VAR = prevVar; else delete process.env.SIRA_VAR;
    if (prevDb !== undefined) process.env.SIRA_DB = prevDb;
  }
}

export async function runEvalSuite(
  mainDb: Db,
  agentKey: string,
  cases: EvalCase[],
  scratchRoot: string,
  promptsDir: string,
): Promise<EvalRunSummary> {
  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    results.push(await runCase(agentKey, evalCase, scratchRoot, promptsDir));
  }

  const totalWeight = results.reduce((s, r) => s + r.weight, 0);
  const passWeight = results.filter((r) => r.passed).reduce((s, r) => s + r.weight, 0);
  const score = totalWeight ? Math.round((passWeight / totalWeight) * 100) : 0;

  const version = mainDb.get<{ id: string }>(
    `SELECT pv.id FROM prompt_versions pv JOIN prompts p ON p.id = pv.prompt_id
     WHERE p.scope = 'agent' AND p.key = ? ORDER BY pv.version DESC LIMIT 1`, agentKey,
  );
  const promptVersionId = version?.id ?? 'unknown';

  const baseline = mainDb.get<{ score: number }>(
    `SELECT score FROM eval_runs WHERE agent_key = ? AND tier = 'mechanical' ORDER BY created_at DESC LIMIT 1`, agentKey,
  );

  const runId = ulid('evr');
  mainDb.transaction(() => {
    mainDb.run(
      `INSERT INTO eval_runs (id, agent_key, prompt_version_id, tier, adapter, total, passed, score, baseline_score, verdict, created_at)
       VALUES (?, ?, ?, 'mechanical', 'mock', ?, ?, ?, ?, ?, ?)`,
      runId, agentKey, promptVersionId, results.length, results.filter((r) => r.passed).length, score,
      baseline?.score ?? null,
      score === 100 ? 'pass' : 'fail',
      Date.now(),
    );
    for (const r of results) {
      mainDb.run(
        `INSERT INTO eval_results (id, run_id, case_id, category, passed, score, details) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ulid('evc'), runId, r.caseId, r.category, r.passed ? 1 : 0, r.passed ? 100 : 0, JSON.stringify(r.details),
      );
    }
  });

  return { runId, agentKey, promptVersionId, total: results.length, passed: results.filter((r) => r.passed).length, score, results };
}
