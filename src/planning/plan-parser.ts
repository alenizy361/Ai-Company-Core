// Plan parser/validator. Pure and mechanical: every rejection is a coded rule,
// not a judgment call. Invalid plans are stored with their errors and trigger
// a bounded replan; only valid plans can be proposed to the owner.
import { extractFirstJsonObject } from '../shared/extract-json.ts';
import type { RolePolicy } from '../shared/config.ts';

export const VERIFICATION_TYPES = ['artifact_exists', 'contains', 'json_schema', 'command'] as const;
export type VerificationType = (typeof VERIFICATION_TYPES)[number];

export interface PlanStep {
  step_id: string;
  agent: string;
  title: string;
  spec: string;
  depends_on: string[];
  required_inputs: string[];
  expected_artifacts: string[];
  acceptance_criteria: string[];
  verification: VerificationCheck[];
  priority: number;
  status: 'queued';
}

export interface VerificationCheck {
  type: VerificationType;
  artifact?: string;
  needle?: string;
  schema?: unknown;
  cmd?: string;
  expect_exit?: number;
}

export interface ParsedPlan {
  reply: string;
  team: string[];
  plan: PlanStep[];
}

export interface PlanError {
  code:
    | 'NOT_SINGLE_JSON'
    | 'BAD_SHAPE'
    | 'UNKNOWN_AGENT'
    | 'AGENT_NOT_ACTIVE'
    | 'INVALID_STEP_ID'
    | 'DUPLICATE_STEP_ID'
    | 'UNKNOWN_DEPENDENCY'
    | 'SELF_DEPENDENCY'
    | 'CYCLE'
    | 'VAGUE_SPEC'
    | 'EMPTY_TITLE'
    | 'MISSING_ACCEPTANCE'
    | 'MISSING_ARTIFACTS'
    | 'UNKNOWN_VERIFICATION_TYPE'
    | 'INVALID_VERIFICATION'
    | 'PERMISSION_IMPOSSIBLE'
    | 'INVALID_STATUS'
    | 'INVALID_PRIORITY'
    | 'TOO_MANY_STEPS';
  stepId?: string;
  detail: string;
}

export interface PlanContext {
  /** agent key -> lifecycle */
  agents: Map<string, string>;
  /** agent key -> role policy (for static permission feasibility checks) */
  policies: Record<string, RolePolicy>;
  maxSteps: number;
  minSpecChars: number;
}

const STEP_ID_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function commandAllowed(cmd: string, policy: RolePolicy | undefined): boolean {
  if (!policy) return false;
  const parts = cmd.trim().split(/\s+/);
  if (parts.length === 0) return false;
  return policy.commands.some((allowed) => {
    if (allowed.bin !== parts[0]) return false;
    const prefix = allowed.argsPrefix ?? [];
    return prefix.every((p, i) => parts[i + 1] === p);
  });
}

export function parsePlanResponse(
  text: string,
  ctx: PlanContext,
): { ok: true; plan: ParsedPlan } | { ok: false; errors: PlanError[] } {
  const extracted = extractFirstJsonObject(text);
  if (!extracted.ok) {
    return { ok: false, errors: [{ code: 'NOT_SINGLE_JSON', detail: extracted.error }] };
  }
  const raw = extracted.value as Record<string, unknown>;
  const errors: PlanError[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: [{ code: 'BAD_SHAPE', detail: 'top level is not an object' }] };
  }
  if (typeof raw.reply !== 'string' || raw.reply.trim().length === 0) {
    errors.push({ code: 'BAD_SHAPE', detail: 'reply must be a non-empty string' });
  }
  if (!isStringArray(raw.team)) {
    errors.push({ code: 'BAD_SHAPE', detail: 'team must be an array of agent keys' });
  } else {
    for (const key of raw.team) {
      if (!ctx.agents.has(key)) errors.push({ code: 'UNKNOWN_AGENT', detail: `team member "${key}" is not a known agent` });
    }
  }
  if (!Array.isArray(raw.plan)) {
    errors.push({ code: 'BAD_SHAPE', detail: 'plan must be an array' });
    return { ok: false, errors };
  }
  if (raw.plan.length > ctx.maxSteps) {
    errors.push({ code: 'TOO_MANY_STEPS', detail: `plan has ${raw.plan.length} steps; max ${ctx.maxSteps}` });
  }

  const steps: PlanStep[] = [];
  const seenIds = new Set<string>();

  for (const [index, rawStepUnknown] of (raw.plan as unknown[]).entries()) {
    const s = rawStepUnknown as Record<string, unknown>;
    const label = typeof s?.step_id === 'string' ? s.step_id : `#${index}`;
    if (typeof s !== 'object' || s === null) {
      errors.push({ code: 'BAD_SHAPE', stepId: label, detail: `step ${label} is not an object` });
      continue;
    }

    const stepId = typeof s.step_id === 'string' ? s.step_id : '';
    if (!STEP_ID_RE.test(stepId)) {
      errors.push({ code: 'INVALID_STEP_ID', stepId: label, detail: `step_id "${stepId}" must match ${STEP_ID_RE}` });
    } else if (seenIds.has(stepId)) {
      errors.push({ code: 'DUPLICATE_STEP_ID', stepId, detail: `step_id "${stepId}" appears more than once` });
    }
    seenIds.add(stepId);

    const agent = typeof s.agent === 'string' ? s.agent : '';
    if (!ctx.agents.has(agent)) {
      errors.push({ code: 'UNKNOWN_AGENT', stepId: label, detail: `agent "${agent}" does not exist` });
    } else if (ctx.agents.get(agent) !== 'active') {
      errors.push({
        code: 'AGENT_NOT_ACTIVE',
        stepId: label,
        detail: `agent "${agent}" is not active (lifecycle=${ctx.agents.get(agent)}); it cannot be assigned work`,
      });
    }

    const title = typeof s.title === 'string' ? s.title.trim() : '';
    if (!title) errors.push({ code: 'EMPTY_TITLE', stepId: label, detail: 'title is empty' });

    const spec = typeof s.spec === 'string' ? s.spec : '';
    if (spec.trim().length < ctx.minSpecChars) {
      errors.push({
        code: 'VAGUE_SPEC',
        stepId: label,
        detail: `spec is ${spec.trim().length} chars; a complete executable specification needs >= ${ctx.minSpecChars}`,
      });
    }

    const dependsOn = isStringArray(s.depends_on) ? s.depends_on : s.depends_on === undefined ? [] : null;
    if (dependsOn === null) errors.push({ code: 'BAD_SHAPE', stepId: label, detail: 'depends_on must be a string array' });
    if (dependsOn?.includes(stepId)) errors.push({ code: 'SELF_DEPENDENCY', stepId: label, detail: 'step depends on itself' });

    const requiredInputs = isStringArray(s.required_inputs) ? s.required_inputs : [];
    const expectedArtifacts = isStringArray(s.expected_artifacts) ? s.expected_artifacts : null;
    if (expectedArtifacts === null || expectedArtifacts.length === 0) {
      errors.push({ code: 'MISSING_ARTIFACTS', stepId: label, detail: 'every step needs >= 1 expected artifact' });
    }
    const acceptance = isStringArray(s.acceptance_criteria)
      ? s.acceptance_criteria.filter((c) => c.trim().length > 0)
      : null;
    if (acceptance === null || acceptance.length === 0) {
      errors.push({ code: 'MISSING_ACCEPTANCE', stepId: label, detail: 'every step needs >= 1 non-empty acceptance criterion' });
    }

    const verification: VerificationCheck[] = [];
    if (!Array.isArray(s.verification)) {
      errors.push({ code: 'BAD_SHAPE', stepId: label, detail: 'verification must be an array' });
    } else {
      for (const rawCheck of s.verification as unknown[]) {
        const check = rawCheck as Record<string, unknown>;
        const type = check?.type as VerificationType;
        if (!VERIFICATION_TYPES.includes(type)) {
          errors.push({
            code: 'UNKNOWN_VERIFICATION_TYPE',
            stepId: label,
            detail: `verification type "${String(check?.type)}" not in [${VERIFICATION_TYPES.join(', ')}]`,
          });
          continue;
        }
        if ((type === 'artifact_exists' || type === 'contains' || type === 'json_schema') && typeof check.artifact !== 'string') {
          errors.push({ code: 'INVALID_VERIFICATION', stepId: label, detail: `${type} check requires "artifact"` });
          continue;
        }
        if (type === 'contains' && typeof check.needle !== 'string') {
          errors.push({ code: 'INVALID_VERIFICATION', stepId: label, detail: 'contains check requires "needle"' });
          continue;
        }
        if (type === 'command') {
          if (typeof check.cmd !== 'string' || check.cmd.trim().length === 0) {
            errors.push({ code: 'INVALID_VERIFICATION', stepId: label, detail: 'command check requires "cmd"' });
            continue;
          }
          if (!commandAllowed(check.cmd, ctx.policies[agent])) {
            errors.push({
              code: 'PERMISSION_IMPOSSIBLE',
              stepId: label,
              detail: `verification command "${check.cmd}" is outside agent "${agent}" command policy`,
            });
            continue;
          }
        }
        verification.push({
          type,
          artifact: typeof check.artifact === 'string' ? check.artifact : undefined,
          needle: typeof check.needle === 'string' ? check.needle : undefined,
          schema: check.schema,
          cmd: typeof check.cmd === 'string' ? check.cmd : undefined,
          expect_exit: typeof check.expect_exit === 'number' ? check.expect_exit : 0,
        });
      }
    }

    if (s.status !== undefined && s.status !== 'queued') {
      errors.push({ code: 'INVALID_STATUS', stepId: label, detail: `status must be "queued", got "${String(s.status)}"` });
    }
    const priority = s.priority === undefined ? 3 : s.priority;
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 1 || priority > 5) {
      errors.push({ code: 'INVALID_PRIORITY', stepId: label, detail: `priority must be an integer 1-5, got ${String(s.priority)}` });
    }

    steps.push({
      step_id: stepId,
      agent,
      title,
      spec,
      depends_on: dependsOn ?? [],
      required_inputs: requiredInputs,
      expected_artifacts: expectedArtifacts ?? [],
      acceptance_criteria: acceptance ?? [],
      verification,
      priority: typeof priority === 'number' ? priority : 3,
      status: 'queued',
    });
  }

  // Dependency references + cycle detection (Kahn) over the collected ids.
  for (const step of steps) {
    for (const dep of step.depends_on) {
      if (!seenIds.has(dep)) {
        errors.push({ code: 'UNKNOWN_DEPENDENCY', stepId: step.step_id, detail: `depends_on "${dep}" is not a step in this plan` });
      }
    }
  }
  if (errors.length === 0 && steps.length > 0) {
    const indegree = new Map<string, number>(steps.map((s) => [s.step_id, 0]));
    const dependents = new Map<string, string[]>();
    for (const step of steps) {
      for (const dep of step.depends_on) {
        indegree.set(step.step_id, (indegree.get(step.step_id) ?? 0) + 1);
        dependents.set(dep, [...(dependents.get(dep) ?? []), step.step_id]);
      }
    }
    const queue = steps.filter((s) => (indegree.get(s.step_id) ?? 0) === 0).map((s) => s.step_id);
    let visited = 0;
    while (queue.length) {
      const id = queue.shift() as string;
      visited++;
      for (const next of dependents.get(id) ?? []) {
        const d = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, d);
        if (d === 0) queue.push(next);
      }
    }
    if (visited !== steps.length) {
      const cycleMembers = steps.filter((s) => (indegree.get(s.step_id) ?? 0) > 0).map((s) => s.step_id);
      errors.push({ code: 'CYCLE', detail: `dependency cycle among: ${cycleMembers.join(', ')}` });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    plan: { reply: (raw.reply as string).trim(), team: raw.team as string[], plan: steps },
  };
}
