// The agent execution loop. The model NEVER executes anything: it emits one
// JSON action per turn; the worker validates it, dispatches tools through the
// permission layer, feeds results back as data, and independently verifies
// completion claims. Every turn, tool call, and status change is persisted.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../shared/db.ts';
import { ulid } from '../shared/ids.ts';
import { emitEvent } from '../shared/events.ts';
import { notify } from '../shared/notify.ts';
import { resolveAgentModel } from '../shared/model-tier.ts';
import { loadPermissions, selfDevEnabled, selfDevRoot, type Paths, type SystemConfig } from '../shared/config.ts';
import { assertTransitionTask, type TaskStatus, type ExecutionStatus } from '../shared/statuses.ts';
import { extractFirstJsonObject } from '../shared/extract-json.ts';
import { validate, type SchemaNode } from '../shared/jsonschema.ts';
import { assemblePrompt, type ArtifactRef } from '../promptreg/assemble.ts';
import { getTaskTemplate } from '../promptreg/registry.ts';
import { AdapterError, type ChatMessage, type ModelAdapter } from '../adapters/types.ts';
import { dispatchTool, executeToolCall } from '../tools/dispatch.ts';
import type { ToolCtx } from '../tools/types.ts';
import { getTool } from '../tools/registry.ts';
import type { ClaimedTask } from './claims.ts';
import { taskStillMine } from './claims.ts';
import { verifyCompletion } from './verify.ts';
import { cascadeDependencyFailure, createHandoffsAndUnblock, maybeCompleteObjective } from './handoff.ts';
import type { VerificationCheck } from '../planning/plan-parser.ts';

/**
 * Branches parked in waitForApproval are excluded from the worker's
 * concurrency budget (see src/worker/index.ts) — an away owner must not
 * freeze the whole pipeline behind pending approvals.
 */
export const approvalWaits = { count: 0 };

const TOOL_ACTION_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    action: { const: 'tool' },
    tool: { type: 'string', minLength: 1 },
    args: { type: 'object' },
    reason: { type: 'string' },
  },
  required: ['action', 'tool', 'args'],
  additionalProperties: false,
};

const COMPLETE_ACTION_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    action: { const: 'complete' },
    summary: { type: 'string', minLength: 1 },
    artifacts: { type: 'array', items: { type: 'string' } },
    self_check: { type: 'object' },
    assumptions: { type: 'array', items: { type: 'string' } },
    unresolved: { type: 'array', items: { type: 'string' } },
    next_action: { type: 'string' },
  },
  // artifacts is required: the verifier cross-checks the claim's artifact
  // list against the plan's expected artifacts, so the contract must demand
  // it (an optional field the verifier then fails on would be a trap).
  required: ['action', 'summary', 'artifacts'],
  additionalProperties: false,
};

const FAIL_ACTION_SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    action: { const: 'fail' },
    reason: { type: 'string', minLength: 1 },
    blockers: { type: 'array', items: { type: 'string' } },
    tried: { type: 'array', items: { type: 'string' } },
  },
  required: ['action', 'reason'],
  additionalProperties: false,
};

export type ExecutionOutcome = 'completed' | 'failed' | 'cancelled' | 'lost_claim' | 'requeued';

interface ExecState {
  db: Db;
  cfg: SystemConfig;
  task: ClaimedTask;
  executionId: string;
  workerId: string;
  currentTaskStatus: TaskStatus;
  currentExecStatus: ExecutionStatus;
}

function setStatuses(state: ExecState, taskTo: TaskStatus | null, execTo: ExecutionStatus | null, source: string): boolean {
  const { db, cfg, task } = state;
  const now = Date.now();
  return db.transaction(() => {
    const fence = taskStillMine(db, task.id, state.workerId);
    if (!fence.mine) return false;
    if (taskTo && taskTo !== state.currentTaskStatus) {
      assertTransitionTask(state.currentTaskStatus, taskTo);
      db.run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', taskTo, now, task.id);
      emitEvent(db, {
        type: 'task.status', orgId: cfg.orgId, taskId: task.id, agentKey: task.agent_key,
        payload: { from: state.currentTaskStatus, to: taskTo, source },
      });
      state.currentTaskStatus = taskTo;
    }
    if (execTo && execTo !== state.currentExecStatus) {
      db.run('UPDATE executions SET status = ? WHERE id = ?', execTo, state.executionId);
      state.currentExecStatus = execTo;
    }
    return true;
  });
}

function updateUsageWindows(db: Db, input: number, output: number): void {
  const now = Date.now();
  const windows = [
    { kind: 'session_5h', size: 5 * 3600_000 },
    { kind: 'weekly', size: 7 * 24 * 3600_000 },
  ];
  for (const w of windows) {
    const start = Math.floor(now / w.size) * w.size;
    db.run(
      `INSERT INTO usage_windows (id, kind, window_start, window_end, input_tokens, output_tokens, request_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(kind, window_start) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         request_count = request_count + 1,
         updated_at = excluded.updated_at`,
      ulid('uw'), w.kind, start, start + w.size, input, output, now,
    );
  }
}

function buildInputContext(db: Db, task: ClaimedTask): {
  inputArtifacts: ArtifactRef[];
  handoffNotes: string[];
  memories: { scope: string; key: string; content: string }[];
} {
  const inputArtifacts = db.all<ArtifactRef & { from_agent: string | null }>(
    `SELECT a.id, a.name, a.kind, a.size_bytes, a.content_hash, a.agent_key AS from_agent
     FROM artifacts a JOIN task_dependencies d ON d.depends_on_task_id = a.task_id
     WHERE d.task_id = ? AND a.kind != 'tool_output' AND a.kind != 'transcript'
     ORDER BY a.created_at DESC`,
    task.id,
  );
  // Deduplicate by name, keeping the newest.
  const seen = new Set<string>();
  const deduped = inputArtifacts.filter((a) => (seen.has(a.name) ? false : (seen.add(a.name), true)));

  const handoffs = db.all<{ from_agent: string; summary: string; assumptions: string; unresolved_issues: string; next_action: string }>(
    'SELECT from_agent, summary, assumptions, unresolved_issues, next_action FROM handoffs WHERE to_task_id = ? ORDER BY created_at',
    task.id,
  );
  const handoffNotes = handoffs.map((h) => {
    const assumptions = JSON.parse(h.assumptions || '[]') as string[];
    const unresolved = JSON.parse(h.unresolved_issues || '[]') as string[];
    return `From ${h.from_agent}: ${h.summary}${assumptions.length ? `\nAssumptions: ${assumptions.join('; ')}` : ''}${unresolved.length ? `\nUnresolved: ${unresolved.join('; ')}` : ''}${h.next_action ? `\nRequested next action: ${h.next_action}` : ''}`;
  });

  const memories = db.all<{ scope: string; key: string; content: string }>(
    `SELECT scope, key, content FROM memories
     WHERE (scope = 'company') OR (scope = 'agent' AND agent_key = ?) OR (scope = 'objective' AND objective_id = ?)
     ORDER BY updated_at DESC LIMIT 8`,
    task.agent_key, task.objective_id,
  );
  return { inputArtifacts: deduped, handoffNotes, memories };
}

export async function runExecution(
  db: Db,
  cfg: SystemConfig,
  paths: Paths,
  adapter: ModelAdapter,
  task: ClaimedTask,
  workerId: string,
): Promise<ExecutionOutcome> {
  const executionId = ulid('exe');
  const startedAt = Date.now();
  const policies = loadPermissions();
  const policy = policies[task.agent_key];
  // Self-dev mode: the workspace IS the repository — SIRA works on itself.
  const workspaceRoot = selfDevEnabled() ? selfDevRoot() : join(paths.workspaceDir, task.objective_id);
  mkdirSync(workspaceRoot, { recursive: true });

  const objective = db.get<{ id: string; title: string; description: string }>(
    'SELECT id, title, description FROM objectives WHERE id = ?', task.objective_id,
  ) ?? { id: task.objective_id, title: '(missing objective)', description: '' };

  const state: ExecState = {
    db, cfg, task, executionId, workerId,
    currentTaskStatus: 'running',
    currentExecStatus: 'running',
  };

  const failTask = (reason: string, blockers: string[], requeue: boolean): ExecutionOutcome => {
    const now = Date.now();
    const canRetry = requeue && task.attempt_count < task.max_attempts;
    // Only the worker that actually COMMITS the terminal 'failed' transition
    // may cascade to dependents / finalize the objective. A branch whose
    // claim was lost (sweeper requeued it, another worker took over) must
    // not cancel dependents of a task that is really queued/running/completed.
    let terminalCommitted = false;
    db.transaction(() => {
      db.run(
        `UPDATE executions SET status = 'failed', failure_reason = ?, finished_at = ? WHERE id = ?`,
        reason.slice(0, 2000), now, executionId,
      );
      const fence = taskStillMine(db, task.id, workerId);
      if (fence.mine) {
        if (canRetry) {
          db.run(
            `UPDATE tasks SET status = 'queued', claimed_by = NULL, lease_expires_at = NULL, not_before = ?, blocker = ?, updated_at = ? WHERE id = ?`,
            now + 15000 * task.attempt_count, reason.slice(0, 500), now, task.id,
          );
        } else {
          db.run(
            `UPDATE tasks SET status = 'failed', claimed_by = NULL, lease_expires_at = NULL, blocker = ?, updated_at = ? WHERE id = ?`,
            (blockers[0] ?? reason).slice(0, 500), now, task.id,
          );
          terminalCommitted = true;
        }
        emitEvent(db, {
          type: 'task.status', orgId: cfg.orgId, taskId: task.id, agentKey: task.agent_key,
          payload: { from: state.currentTaskStatus, to: canRetry ? 'queued' : 'failed', source: 'execution_failed', reason: reason.slice(0, 300), blockers },
        });
      }
      emitEvent(db, {
        type: 'execution.finished', orgId: cfg.orgId, executionId, taskId: task.id, agentKey: task.agent_key,
        payload: { status: 'failed', reason: reason.slice(0, 300), willRetry: canRetry },
      });
      if (terminalCommitted) {
        notify(db, cfg.orgId, {
          kind: 'task_failed', priority: 'high',
          title: `Task failed: ${task.title}`, body: reason.slice(0, 500),
          payload: { taskId: task.id, executionId },
        });
      }
    });
    if (terminalCommitted) {
      // Terminal failure: dependents can never run — cancel them honestly so
      // the objective finalizes instead of hanging 'in_progress' forever.
      cascadeDependencyFailure(db, cfg, task.id);
      maybeCompleteObjective(db, cfg, task.objective_id);
    }
    return canRetry ? 'requeued' : 'failed';
  };

  if (!policy) return failTask(`no permission policy configured for agent "${task.agent_key}"`, ['missing_policy'], false);

  db.run(
    `INSERT INTO executions (id, task_id, agent_key, attempt, adapter, status, worker_id, lease_expires_at, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
    executionId, task.id, task.agent_key, task.attempt_count, adapter.name, workerId, Date.now() + cfg.leaseMs, startedAt,
  );
  emitEvent(db, {
    type: 'execution.started', orgId: cfg.orgId, executionId, taskId: task.id, agentKey: task.agent_key,
    payload: { attempt: task.attempt_count, adapter: adapter.name },
  });

  // Assemble the prompt (with retry addendum after failed attempts).
  let spec = task.spec;
  if (task.attempt_count > 1) {
    const lastFailure = db.get<{ failure_reason: string | null }>(
      `SELECT failure_reason FROM executions WHERE task_id = ? AND id != ? ORDER BY started_at DESC LIMIT 1`,
      task.id, executionId,
    );
    const template = getTaskTemplate(db, 'recovery-template') ?? '';
    spec += `\n\n${template}\nPrevious attempt failure: ${lastFailure?.failure_reason ?? task.blocker ?? 'unknown'}`;
  }

  const { inputArtifacts, handoffNotes, memories } = buildInputContext(db, task);
  const toolSpecs = policy.tools
    .map((name) => getTool(name))
    .filter((t): t is NonNullable<typeof t> => !!t)
    .map((t) => ({
      name: t.name,
      description: t.description,
      schema: t.schema,
      approvalRequired: policy.approvalRequired.some((m) => m.tool === t.name),
    }));

  const orgName = db.get<{ name: string }>('SELECT name FROM orgs WHERE id = ?', cfg.orgId)?.name ?? 'SIRA';
  const agentModel = resolveAgentModel(db, cfg, task.agent_key);
  let assembled;
  try {
    assembled = assemblePrompt(db, {
      agentKey: task.agent_key,
      contract: 'execution',
      companyName: orgName,
      objective,
      task: {
        id: task.id,
        step_id: task.step_id,
        title: task.title,
        spec,
        acceptance_criteria: JSON.parse(task.acceptance_criteria || '[]'),
        verification: JSON.parse(task.verification || '[]'),
        expected_artifacts: JSON.parse(task.expected_artifacts || '[]'),
        required_inputs: JSON.parse(task.required_inputs || '[]'),
      },
      inputArtifacts,
      handoffNotes,
      memories,
      tools: toolSpecs,
      policy: {
        readPaths: policy.paths.read,
        writePaths: policy.paths.write,
        commands: policy.commands.map((c) => [c.bin, ...(c.argsPrefix ?? [])].join(' ') + ' ...'),
      },
    });
  } catch (err) {
    return failTask(`prompt assembly failed: ${err instanceof Error ? err.message : String(err)}`, ['prompt_assembly'], false);
  }
  db.run('UPDATE executions SET prompt_version_id = ?, core_bundle_hash = ? WHERE id = ?',
    assembled.promptVersionId, assembled.coreBundleHash, executionId);

  const toolCtx: ToolCtx = {
    db, cfg,
    orgId: cfg.orgId,
    objectiveId: task.objective_id,
    taskId: task.id,
    executionId,
    agentKey: task.agent_key,
    workspaceRoot,
    artifactsDir: paths.artifactsDir,
  };

  const messages: ChatMessage[] = [{ role: 'user', content: assembled.firstUserMessage }];
  // Consecutive user turns are merged so the transcript stays strictly
  // alternating even when an assistant turn is skipped (e.g. the model
  // produced no text) — the Anthropic API rejects empty assistant content.
  const pushUser = (content: string): void => {
    const last = messages[messages.length - 1];
    if (last?.role === 'user') last.content += `\n\n${content}`;
    else messages.push({ role: 'user', content });
  };
  let contractStrikes = 0;
  let verifyFailures = 0;
  let totalIn = 0;
  let totalOut = 0;

  for (let turn = 0; turn < cfg.maxTurnsPerExecution; turn++) {
    // Fencing + cancellation before every model call.
    const fence = taskStillMine(db, task.id, workerId);
    if (!fence.mine) {
      const cancelled = fence.status === 'cancelled';
      db.run(`UPDATE executions SET status = ?, failure_reason = ?, finished_at = ? WHERE id = ?`,
        cancelled ? 'cancelled' : 'abandoned', cancelled ? 'task cancelled by owner' : 'claim lost (lease expired or reassigned)',
        Date.now(), executionId);
      emitEvent(db, {
        type: 'execution.finished', orgId: cfg.orgId, executionId, taskId: task.id, agentKey: task.agent_key,
        payload: { status: cancelled ? 'cancelled' : 'abandoned' },
      });
      return cancelled ? 'cancelled' : 'lost_claim';
    }
    if (Date.now() - startedAt > cfg.maxWallClockMs) {
      return failTask(`wall clock cap exceeded (${cfg.maxWallClockMs}ms)`, ['wall_clock_exceeded'], true);
    }

    // Model call.
    const requestId = ulid('mr');
    const callStart = Date.now();
    let text: string;
    try {
      const res = await adapter.complete({ system: assembled.system, messages, purpose: 'execution', model: agentModel });
      text = res.text;
      totalIn += res.usage.input;
      totalOut += res.usage.output;
      db.run(
        `INSERT INTO model_requests (id, execution_id, purpose, adapter, model, turn_index, prompt_chars, response_text, parse_status, input_tokens, output_tokens, duration_ms, created_at)
         VALUES (?, ?, 'execution', ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?)`,
        requestId, executionId, adapter.name, res.model, turn,
        assembled.system.length + messages.reduce((n, m) => n + m.content.length, 0),
        text.slice(0, 100000), res.usage.input, res.usage.output, Date.now() - callStart, Date.now(),
      );
      updateUsageWindows(db, res.usage.input, res.usage.output);
      db.run('UPDATE executions SET turns_used = ?, input_tokens = ?, output_tokens = ? WHERE id = ?',
        turn + 1, totalIn, totalOut, executionId);
    } catch (err) {
      const retryable = err instanceof AdapterError ? err.retryable : true;
      const detail = err instanceof Error ? err.message : String(err);
      db.run(
        `INSERT INTO model_requests (id, execution_id, purpose, adapter, model, turn_index, prompt_chars, response_text, parse_status, error, input_tokens, output_tokens, duration_ms, created_at)
         VALUES (?, ?, 'execution', ?, '', ?, 0, '', 'adapter_error', ?, 0, 0, ?, ?)`,
        requestId, executionId, adapter.name, turn, detail.slice(0, 2000), Date.now() - callStart, Date.now(),
      );
      return failTask(`model adapter error: ${detail}`, ['adapter_error'], retryable);
    }

    // Never persist an empty assistant turn (the next API call would 400 on
    // empty content); the contract-violation branch below handles the retry.
    if (text.trim().length > 0) messages.push({ role: 'assistant', content: text });

    // Parse + validate the single-action contract.
    const extracted = extractFirstJsonObject(text);
    let action: Record<string, unknown> | null = null;
    let contractError: string | null = null;
    if (!extracted.ok) {
      contractError = extracted.error;
    } else {
      const obj = extracted.value as Record<string, unknown>;
      const kind = obj?.action;
      const schema = kind === 'tool' ? TOOL_ACTION_SCHEMA : kind === 'complete' ? COMPLETE_ACTION_SCHEMA : kind === 'fail' ? FAIL_ACTION_SCHEMA : null;
      if (!schema) contractError = `action must be "tool", "complete", or "fail"; got ${JSON.stringify(kind)}`;
      else {
        const errors = validate(schema, obj);
        if (errors.length) contractError = errors.map((e) => `${e.path}: ${e.message}`).join('; ');
        else action = obj;
      }
    }

    if (contractError || !action) {
      contractStrikes++;
      db.run(`UPDATE model_requests SET parse_status = 'parse_error', error = ? WHERE id = ?`, contractError, requestId);
      emitEvent(db, {
        type: 'model.validation_failed', orgId: cfg.orgId, executionId, taskId: task.id, agentKey: task.agent_key,
        payload: { turn, strike: contractStrikes, error: contractError },
      });
      if (contractStrikes >= 3) {
        return failTask(`output contract violated 3 times; last error: ${contractError}`, ['contract_violation'], true);
      }
      pushUser(JSON.stringify({
        contract_violation: contractError,
        instruction: 'Respond again with EXACTLY ONE valid JSON action object and nothing else.',
      }));
      continue;
    }

    if (action.action === 'tool') {
      if (!setStatuses(state, 'waiting_for_tool', 'waiting_for_tool', 'tool_dispatch')) continue;
      const outcome = await dispatchTool(db, toolCtx, policy, turn, String(action.tool), (action.args ?? {}) as Record<string, unknown>);

      if (outcome.decision === 'approval_required') {
        setStatuses(state, 'waiting_for_approval', 'waiting_for_approval', 'approval_requested');
        approvalWaits.count++;
        let approvalResult;
        try {
          approvalResult = await waitForApproval(db, cfg, outcome.approvalId as string, workerId, task.id);
        } finally {
          approvalWaits.count--;
        }
        if (approvalResult === 'timeout') {
          return failTask('owner approval not received within the timeout', ['approval_timeout'], false);
        }
        if (approvalResult === 'lost') {
          continue; // fence check at top of loop will finalize
        }
        if (approvalResult === 'rejected') {
          setStatuses(state, 'running', 'running', 'approval_rejected');
          pushUser(JSON.stringify({ tool_result: { ok: false, status: 'rejected', detail: 'The owner rejected this action. Adapt your approach or fail honestly.' } }));
          continue;
        }
        // Approved: actually execute the recorded call now.
        setStatuses(state, 'running', 'running', 'approval_granted');
        const executed = await executeToolCall(db, toolCtx, outcome.toolCallId, String(action.tool), (action.args ?? {}) as Record<string, unknown>);
        pushUser(JSON.stringify({ tool_result: { status: 'approved_and_executed', ...formatResult(executed.result) } }));
        continue;
      }

      setStatuses(state, 'running', 'running', 'tool_done');
      pushUser(JSON.stringify({ tool_result: formatResult(outcome.result) }));
      continue;
    }

    if (action.action === 'fail') {
      const blockers = Array.isArray(action.blockers) ? (action.blockers as string[]) : [];
      return failTask(String(action.reason), blockers, false);
    }

    // action === 'complete': backend verification decides.
    if (!setStatuses(state, 'verifying', 'verifying', 'completion_claimed')) continue;
    emitEvent(db, {
      type: 'execution.verifying', orgId: cfg.orgId, executionId, taskId: task.id, agentKey: task.agent_key,
      payload: { summary: String(action.summary).slice(0, 500) },
    });

    const verdict = verifyCompletion(db, {
      taskId: task.id,
      objectiveId: task.objective_id,
      expectedArtifacts: JSON.parse(task.expected_artifacts || '[]'),
      claimedArtifacts: Array.isArray(action.artifacts) ? (action.artifacts as string[]) : [],
      checks: JSON.parse(task.verification || '[]') as VerificationCheck[],
      workspaceRoot,
      policy,
      commandTimeoutMs: cfg.toolTimeoutMs,
    });
    emitEvent(db, {
      type: 'verification.result', orgId: cfg.orgId, executionId, taskId: task.id, agentKey: task.agent_key,
      payload: { passed: verdict.passed, results: verdict.results },
    });

    if (!verdict.passed) {
      verifyFailures++;
      if (verifyFailures >= 2) {
        return failTask(
          `verification failed after ${verifyFailures} completion claims: ${verdict.results.filter((r) => !r.ok).map((r) => `${r.check}: ${r.detail}`).join('; ')}`,
          ['verification_failed'], true,
        );
      }
      setStatuses(state, 'running', 'running', 'verification_failed');
      pushUser(JSON.stringify({
        verification_failed: verdict.results.filter((r) => !r.ok),
        instruction: 'Fix the unmet checks with tool actions, then claim completion again — or fail honestly if you cannot.',
      }));
      continue;
    }

    // Verified completion.
    const now = Date.now();
    const ok = db.transaction(() => {
      const fenceNow = taskStillMine(db, task.id, workerId);
      if (!fenceNow.mine) return false;
      db.run(`UPDATE executions SET status = 'completed', finished_at = ? WHERE id = ?`, now, executionId);
      db.run(`UPDATE tasks SET status = 'completed', claimed_by = NULL, lease_expires_at = NULL, blocker = NULL, updated_at = ? WHERE id = ?`, now, task.id);
      emitEvent(db, {
        type: 'task.status', orgId: cfg.orgId, taskId: task.id, agentKey: task.agent_key,
        payload: { from: 'verifying', to: 'completed', source: 'verification_passed' },
      });
      emitEvent(db, {
        type: 'execution.finished', orgId: cfg.orgId, executionId, taskId: task.id, agentKey: task.agent_key,
        payload: { status: 'completed', summary: String(action.summary).slice(0, 500), turns: turn + 1, inputTokens: totalIn, outputTokens: totalOut },
      });
      return true;
    });
    if (!ok) continue;

    createHandoffsAndUnblock(db, cfg, task, executionId, {
      summary: String(action.summary),
      assumptions: Array.isArray(action.assumptions) ? (action.assumptions as string[]) : [],
      unresolved: Array.isArray(action.unresolved) ? (action.unresolved as string[]) : [],
      nextAction: typeof action.next_action === 'string' ? action.next_action : '',
    });
    maybeCompleteObjective(db, cfg, task.objective_id);
    return 'completed';
  }

  return failTask(`turn cap (${cfg.maxTurnsPerExecution}) exhausted without completion`, ['turn_cap_exceeded'], true);
}

function formatResult(result: { ok: boolean; data?: Record<string, unknown>; error?: string }): Record<string, unknown> {
  return { ok: result.ok, ...(result.data ?? {}), ...(result.error ? { error: result.error } : {}) };
}

async function waitForApproval(
  db: Db,
  cfg: SystemConfig,
  approvalId: string,
  workerId: string,
  taskId: string,
): Promise<'approved' | 'rejected' | 'timeout' | 'lost'> {
  const deadline = Date.now() + cfg.approvalTimeoutMs;
  for (;;) {
    const row = db.get<{ status: string }>('SELECT status FROM approvals WHERE id = ?', approvalId);
    if (row?.status === 'approved') return 'approved';
    if (row?.status === 'rejected') return 'rejected';
    if (Date.now() > deadline) {
      db.run(`UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'`, Date.now(), approvalId);
      return 'timeout';
    }
    const fence = taskStillMine(db, taskId, workerId);
    if (!fence.mine) return 'lost';
    await new Promise((r) => setTimeout(r, 2000));
  }
}
