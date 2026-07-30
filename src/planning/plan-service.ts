// Planning lifecycle: objective -> CEO planning call -> validated plan
// (proposed) -> owner confirmation -> persistent tasks. The model call itself
// runs in the worker (runPlanningForObjective); the API only creates
// objectives and confirms/rejects proposed plans.
import type { Db } from '../shared/db.ts';
import { ulid } from '../shared/ids.ts';
import { emitEvent, audit } from '../shared/events.ts';
import { notify } from '../shared/notify.ts';
import { loadPermissions, loadSystemConfig, type SystemConfig } from '../shared/config.ts';
import { getActiveCoreBundle, getActiveAgentPrompt } from '../promptreg/registry.ts';
import { parsePlanResponse, type ParsedPlan, type PlanError } from './plan-parser.ts';
import type { ModelAdapter } from '../adapters/types.ts';
import { AdapterError } from '../adapters/types.ts';
import { resolveAgentModel } from '../shared/model-tier.ts';

export interface ObjectiveRow {
  id: string;
  org_id: string;
  title: string;
  description: string;
  status: string;
  conversation_id: string | null;
  originating_message_id: string | null;
  replan_count: number;
}

export function createObjective(
  db: Db,
  cfg: SystemConfig,
  input: { title: string; description?: string; createdBy?: string; conversationId?: string | null; originatingMessageId?: string | null },
): ObjectiveRow {
  const id = ulid('obj');
  const now = Date.now();
  db.transaction(() => {
    db.run(
      `INSERT INTO objectives (id, org_id, title, description, created_by, status, conversation_id, originating_message_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      id, cfg.orgId, input.title, input.description ?? '', input.createdBy ?? 'owner',
      input.conversationId ?? null, input.originatingMessageId ?? null, now, now,
    );
    emitEvent(db, { type: 'objective.created', orgId: cfg.orgId, payload: { objectiveId: id, title: input.title } });
    audit(db, cfg.orgId, input.createdBy ?? 'owner', 'objective.create', 'objective', id, { title: input.title });
  });
  return db.get<ObjectiveRow>('SELECT * FROM objectives WHERE id = ?', id) as ObjectiveRow;
}

function buildPlanningPrompt(db: Db, cfg: SystemConfig, objective: ObjectiveRow, replanErrors: PlanError[] | null): {
  system: string;
  user: string;
  promptVersionId: string;
  coreBundleHash: string;
} {
  const core = getActiveCoreBundle(db);
  const ceo = getActiveAgentPrompt(db, 'ceo');
  const activeAgents = db.all<{ key: string; name_en: string; lifecycle: string }>(
    `SELECT key, name_en, lifecycle FROM agents ORDER BY key`,
  );
  const policies = loadPermissions();
  const roster = activeAgents
    .map((a) => {
      const tools = policies[a.key]?.tools.join(', ') ?? '';
      return `- ${a.key} (${a.name_en}) — lifecycle: ${a.lifecycle}${a.lifecycle === 'active' ? ` — tools: ${tools}` : ' — NOT ASSIGNABLE'}`;
    })
    .join('\n');

  const memories = db.all<{ key: string; content: string }>(
    `SELECT key, content FROM memories WHERE scope = 'company' ORDER BY updated_at DESC LIMIT 10`,
  );
  const memoryText = memories.length
    ? memories.map((m) => `- [${m.key}] ${m.content}`).join('\n').slice(0, 2000)
    : '(none recorded yet)';

  const recentObjectives = db.all<{ title: string; status: string }>(
    `SELECT title, status FROM objectives WHERE id != ? ORDER BY created_at DESC LIMIT 5`,
    objective.id,
  );

  const sections = [
    `# PLANNING TASK`,
    `Owner objective: ${objective.title}`,
    objective.description ? `Details: ${objective.description}` : '',
    `\n## Agent roster (assign steps ONLY to lifecycle=active agents)\n${roster}`,
    `\n## Company memory\n${memoryText}`,
    recentObjectives.length
      ? `\n## Recent objectives\n${recentObjectives.map((o) => `- [${o.status}] ${o.title}`).join('\n')}`
      : '',
  ];
  if (replanErrors?.length) {
    sections.push(
      `\n## YOUR PREVIOUS PLAN WAS REJECTED BY THE VALIDATOR — fix every error\n${replanErrors
        .map((e) => `- ${e.code}${e.stepId ? ` (step ${e.stepId})` : ''}: ${e.detail}`)
        .join('\n')}`,
    );
  }
  sections.push(
    `\n## Respond now\nReply with exactly ONE JSON object following the PLANNING OUTPUT CONTRACT. plan=[] if the objective needs only an answer. Minimal graph; sequence instead of parallelizing unless parallelism is clearly worth shared-quota cost.`,
  );

  return {
    system: `${core.text}\n\n# YOUR ROLE\n\n${ceo.content}`,
    user: sections.filter(Boolean).join('\n'),
    promptVersionId: ceo.id,
    coreBundleHash: core.hash,
  };
}

export interface PlanningOutcome {
  status: 'proposed' | 'rejected_exhausted' | 'error';
  planId?: string;
  errors?: PlanError[];
  detail?: string;
}

/**
 * Terminal planning failure: the objective must NEVER stay claimed in
 * 'planning' (a live worker's heartbeat would renew that lease forever) and
 * the owner must actually hear about it — event + notification, not a log line.
 * Fenced on claimed_by: a worker whose lease lapsed (sweeper reopened the
 * objective, another worker took over) must not stomp 'failed' over live work.
 */
function failObjectivePlanning(
  db: Db, cfg: SystemConfig, objective: { id: string; title: string }, reason: string, workerId: string | null,
): void {
  const now = Date.now();
  db.transaction(() => {
    const changed = db.run(
      `UPDATE objectives SET status = 'failed', claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'planning'${workerId ? ' AND claimed_by = ?' : ''}`,
      ...(workerId ? [now, objective.id, workerId] : [now, objective.id]),
    );
    if (Number(changed.changes) === 0) return; // claim lost — the current owner decides this objective's fate
    emitEvent(db, {
      type: 'objective.finished', orgId: cfg.orgId,
      payload: { objectiveId: objective.id, status: 'failed', reason: reason.slice(0, 300) },
    });
    notify(db, cfg.orgId, {
      kind: 'objective_failed', priority: 'high',
      title: `Objective failed: ${objective.title}`,
      body: reason.slice(0, 500),
      payload: { objectiveId: objective.id },
    });
  });
}

/** Release a planning claim so the objective can be re-claimed and retried (fenced on claimed_by). */
function releasePlanningClaim(db: Db, objectiveId: string, workerId: string | null): void {
  db.run(
    `UPDATE objectives SET status = 'open', claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND status = 'planning'${workerId ? ' AND claimed_by = ?' : ''}`,
    ...(workerId ? [Date.now(), objectiveId, workerId] : [Date.now(), objectiveId]),
  );
}

/** Runs the full planning attempt loop for one objective (called by the worker). */
export async function runPlanningForObjective(
  db: Db,
  adapter: ModelAdapter,
  objectiveId: string,
  workerId: string | null = null,
): Promise<PlanningOutcome> {
  const cfg = loadSystemConfig();
  const objective = db.get<ObjectiveRow>('SELECT * FROM objectives WHERE id = ?', objectiveId);
  if (!objective) return { status: 'error', detail: 'objective missing' };
  try {
    return await runPlanningAttempts(db, adapter, cfg, objective, workerId);
  } catch (err) {
    // Any unexpected throw (missing prompt version, DB error, ...) must not
    // leave the objective deadlocked in 'planning'. Fail it honestly.
    const detail = err instanceof Error ? err.message : String(err);
    failObjectivePlanning(db, cfg, objective, `planning crashed: ${detail}`, workerId);
    return { status: 'error', detail };
  }
}

async function runPlanningAttempts(
  db: Db,
  adapter: ModelAdapter,
  cfg: SystemConfig,
  objective: ObjectiveRow,
  workerId: string | null,
): Promise<PlanningOutcome> {
  const objectiveId = objective.id;
  const agents = new Map(
    db.all<{ key: string; lifecycle: string }>('SELECT key, lifecycle FROM agents').map((a) => [a.key, a.lifecycle]),
  );
  const policies = loadPermissions();

  let lastErrors: PlanError[] | null = null;

  for (let attempt = 0; attempt <= cfg.maxReplans; attempt++) {
    const prompt = buildPlanningPrompt(db, cfg, objective, lastErrors);
    const requestId = ulid('mr');
    const started = Date.now();
    let text: string;
    let usage = { input: 0, output: 0 };
    let model: string = adapter.name;
    try {
      const res = await adapter.complete({
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        purpose: 'planning',
        model: resolveAgentModel(db, cfg, 'ceo'), // planning is the CEO's job
      });
      text = res.text;
      usage = res.usage;
      model = res.model;
      db.run(
        `INSERT INTO model_requests (id, execution_id, purpose, adapter, model, turn_index, prompt_chars, response_text, parse_status, input_tokens, output_tokens, duration_ms, created_at)
         VALUES (?, NULL, 'planning', ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?)`,
        requestId, adapter.name, model, attempt, prompt.system.length + prompt.user.length,
        text.slice(0, 100000), usage.input, usage.output, Date.now() - started, Date.now(),
      );
    } catch (err) {
      const detail = err instanceof AdapterError ? err.message : String(err);
      const retryable = err instanceof AdapterError ? err.retryable : true;
      db.run(
        `INSERT INTO model_requests (id, execution_id, purpose, adapter, model, turn_index, prompt_chars, response_text, parse_status, error, input_tokens, output_tokens, duration_ms, created_at)
         VALUES (?, NULL, 'planning', ?, ?, ?, ?, '', 'adapter_error', ?, 0, 0, ?, ?)`,
        requestId, adapter.name, model, attempt, prompt.system.length + prompt.user.length, detail, Date.now() - started, Date.now(),
      );
      emitEvent(db, { type: 'planning.adapter_error', orgId: cfg.orgId, payload: { objectiveId, detail } });
      // The objective must not stay claimed in 'planning' (the worker
      // heartbeat would renew that lease forever). Retryable failures go back
      // to 'open' within the bounded attempt budget; everything else fails
      // loudly with a notification.
      const attemptsUsed = (db.get<{ n: number }>('SELECT replan_count AS n FROM objectives WHERE id = ?', objectiveId)?.n ?? 0) + 1;
      db.run('UPDATE objectives SET replan_count = replan_count + 1, updated_at = ? WHERE id = ?', Date.now(), objectiveId);
      if (retryable && attemptsUsed <= cfg.maxReplans) {
        releasePlanningClaim(db, objectiveId, workerId);
      } else {
        failObjectivePlanning(db, cfg, objective, `planning model call failed after ${attemptsUsed} attempt(s): ${detail}`, workerId);
      }
      return { status: 'error', detail };
    }

    const parsed = parsePlanResponse(text, {
      agents,
      policies,
      maxSteps: cfg.maxPlanSteps,
      minSpecChars: 80,
    });

    const planId = ulid('pln');
    const now = Date.now();
    // The version is computed INSIDE each insert transaction — two planners
    // racing on the same objective must not collide on UNIQUE(objective_id, version).
    const nextVersion = (): number =>
      (db.get<{ m: number | null }>('SELECT MAX(version) AS m FROM plans WHERE objective_id = ?', objectiveId)?.m ?? 0) + 1;

    if (!parsed.ok) {
      db.transaction(() => {
        const version = nextVersion();
        db.run(
          `INSERT INTO plans (id, objective_id, version, model_request_id, raw_json, reply, status, validation_errors, created_at)
           VALUES (?, ?, ?, ?, ?, '', 'rejected', ?, ?)`,
          planId, objectiveId, version, requestId, text.slice(0, 100000), JSON.stringify(parsed.errors), now,
        );
        // The model_requests row must record the contract failure too — an
        // audit of parse_status would otherwise undercount planning failures.
        db.run(`UPDATE model_requests SET parse_status = 'parse_error', error = ? WHERE id = ?`,
          parsed.errors.map((e) => e.code).join(',').slice(0, 500), requestId);
        db.run('UPDATE objectives SET replan_count = replan_count + 1, updated_at = ? WHERE id = ?', now, objectiveId);
        emitEvent(db, {
          type: 'plan.validation_failed',
          orgId: cfg.orgId,
          payload: { objectiveId, planId, attempt, errors: parsed.errors },
        });
      });
      lastErrors = parsed.errors;
      continue;
    }

    db.transaction(() => {
      const version = nextVersion();
      db.run(
        `INSERT INTO plans (id, objective_id, version, model_request_id, raw_json, reply, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?)`,
        planId, objectiveId, version, requestId, JSON.stringify(parsed.plan), parsed.plan.reply, now,
      );
      db.run(`UPDATE objectives SET status = 'plan_proposed', updated_at = ? WHERE id = ?`, now, objectiveId);
      emitEvent(db, {
        type: 'plan.proposed',
        orgId: cfg.orgId,
        payload: {
          objectiveId, planId, reply: parsed.plan.reply, team: parsed.plan.team, stepCount: parsed.plan.plan.length,
        },
      });
    });
    return { status: 'proposed', planId };
  }

  emitEvent(db, {
    type: 'planning.exhausted',
    orgId: cfg.orgId,
    payload: { objectiveId, errors: lastErrors },
  });
  failObjectivePlanning(
    db, cfg, objective,
    `planning exhausted after ${cfg.maxReplans + 1} attempts; last validator errors: ${
      (lastErrors ?? []).map((e) => `${e.code}: ${e.detail}`).join('; ').slice(0, 400) || 'none recorded'}`,
    workerId,
  );
  return { status: 'rejected_exhausted', errors: lastErrors ?? [] };
}

export function confirmPlan(db: Db, planId: string, decidedBy: string, via: 'ui' | 'voice' | 'api' = 'ui'): { taskIds: string[] } {
  const cfg = loadSystemConfig();
  return db.transaction(() => {
    const plan = db.get<{ id: string; objective_id: string; status: string; raw_json: string }>(
      'SELECT id, objective_id, status, raw_json FROM plans WHERE id = ?',
      planId,
    );
    if (!plan) throw new Error('plan not found');
    if (plan.status !== 'proposed') throw new Error(`plan is ${plan.status}, not proposed`);
    const parsed = JSON.parse(plan.raw_json) as ParsedPlan;
    const now = Date.now();

    const idByStep = new Map<string, string>();
    for (const step of parsed.plan) idByStep.set(step.step_id, ulid('tsk'));

    for (const step of parsed.plan) {
      const taskId = idByStep.get(step.step_id) as string;
      const initialStatus = step.depends_on.length === 0 ? 'queued' : 'waiting_for_dependency';
      db.run(
        `INSERT INTO tasks (id, plan_id, objective_id, step_id, agent_key, title, spec, required_inputs, expected_artifacts,
           acceptance_criteria, verification, priority, status, max_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        taskId, plan.id, plan.objective_id, step.step_id, step.agent, step.title, step.spec,
        JSON.stringify(step.required_inputs), JSON.stringify(step.expected_artifacts),
        JSON.stringify(step.acceptance_criteria), JSON.stringify(step.verification),
        step.priority, initialStatus, cfg.maxAttempts, now, now,
      );
      emitEvent(db, {
        type: 'task.created',
        orgId: cfg.orgId,
        taskId,
        agentKey: step.agent,
        payload: { stepId: step.step_id, title: step.title, status: initialStatus, objectiveId: plan.objective_id },
      });
    }
    for (const step of parsed.plan) {
      for (const dep of step.depends_on) {
        db.run(
          'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)',
          idByStep.get(step.step_id) as string, idByStep.get(dep) as string,
        );
      }
    }

    db.run(`UPDATE plans SET status = 'confirmed', confirmed_at = ? WHERE id = ?`, now, plan.id);
    db.run(`UPDATE plans SET status = 'superseded' WHERE objective_id = ? AND status = 'proposed' AND id != ?`, plan.objective_id, plan.id);
    db.run(`UPDATE objectives SET status = ?, updated_at = ? WHERE id = ?`,
      parsed.plan.length === 0 ? 'completed' : 'in_progress', now, plan.objective_id);

    emitEvent(db, {
      type: 'plan.confirmed',
      orgId: cfg.orgId,
      payload: { planId: plan.id, objectiveId: plan.objective_id, taskCount: parsed.plan.length, decidedBy, via },
    });
    if (parsed.plan.length === 0) {
      // Answer-only objective: confirming an empty plan closes it with zero
      // tasks. Say so explicitly — "completed" must never imply work happened.
      const obj = db.get<{ title: string }>('SELECT title FROM objectives WHERE id = ?', plan.objective_id);
      emitEvent(db, {
        type: 'objective.finished', orgId: cfg.orgId,
        payload: { objectiveId: plan.objective_id, status: 'completed', answerOnly: true },
      });
      notify(db, cfg.orgId, {
        kind: 'objective_completed', priority: 'normal',
        title: `Objective closed (answer only): ${obj?.title ?? plan.objective_id}`,
        body: 'The confirmed plan had no execution steps — the reply itself was the deliverable. No tasks ran.',
        payload: { objectiveId: plan.objective_id },
      });
    }
    audit(db, cfg.orgId, decidedBy, 'plan.confirm', 'plan', plan.id, { via, taskCount: parsed.plan.length });
    return { taskIds: [...idByStep.values()] };
  });
}

export function rejectPlan(db: Db, planId: string, decidedBy: string, reason: string): void {
  const cfg = loadSystemConfig();
  db.transaction(() => {
    const plan = db.get<{ id: string; objective_id: string; status: string }>(
      'SELECT id, objective_id, status FROM plans WHERE id = ?', planId,
    );
    if (!plan) throw new Error('plan not found');
    if (plan.status !== 'proposed') throw new Error(`plan is ${plan.status}, not proposed`);
    const now = Date.now();
    db.run(`UPDATE plans SET status = 'rejected', validation_errors = ? WHERE id = ?`,
      JSON.stringify([{ code: 'OWNER_REJECTED', detail: reason }]), plan.id);
    db.run(`UPDATE objectives SET status = 'open', updated_at = ? WHERE id = ?`, now, plan.objective_id);
    emitEvent(db, { type: 'plan.rejected', orgId: cfg.orgId, payload: { planId: plan.id, objectiveId: plan.objective_id, reason, decidedBy } });
    audit(db, cfg.orgId, decidedBy, 'plan.reject', 'plan', plan.id, { reason });
  });
}
