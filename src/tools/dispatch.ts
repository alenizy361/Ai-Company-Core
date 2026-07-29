// dispatchTool: THE single permission-enforcement point. Every tool request
// from every agent passes through here; nothing else executes tools. Order:
//   1. tool exists  2. role allowlist  3. args schema  4. path containment +
//   read/write globs  5. command allowlist  6. approval gate  7. execute with
//   timeout, record result. Every call gets a tool_calls row; denials also
//   emit tool.denied events with the structured reason.
import { mkdirSync } from 'node:fs';
import type { Db } from '../shared/db.ts';
import { ulid } from '../shared/ids.ts';
import { emitEvent } from '../shared/events.ts';
import { validate } from '../shared/jsonschema.ts';
import type { RolePolicy } from '../shared/config.ts';
import { getTool } from './registry.ts';
import type { ToolCtx, ToolResult } from './types.ts';
import { approvalRequired, approvalSubject, commandAllowed, pathAllowed, resolveWorkspacePath } from './policy.ts';
import { storeArtifact } from './impl/artifacts.ts';

export interface DispatchOutcome {
  decision: 'allowed' | 'denied' | 'approval_required';
  toolCallId: string;
  approvalId?: string;
  /** The result fed back to the model (for denied: the structured denial). */
  result: ToolResult;
}

const PATH_TOOLS: Record<string, 'read' | 'write'> = {
  read_file: 'read',
  list_dir: 'read',
  search: 'read',
  write_file: 'write',
};

function recordCall(
  db: Db,
  ctx: ToolCtx,
  turnIndex: number,
  tool: string,
  args: Record<string, unknown>,
  decision: 'allowed' | 'denied' | 'approval_required',
  status: string,
  denialReason?: string,
): string {
  const id = ulid('tc');
  const publicArgs = Object.fromEntries(Object.entries(args).filter(([k]) => !k.startsWith('__')));
  db.run(
    `INSERT INTO tool_calls (id, execution_id, task_id, agent_key, turn_index, tool, args_json, decision, denial_reason, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, ctx.executionId, ctx.taskId, ctx.agentKey, turnIndex, tool,
    JSON.stringify(publicArgs).slice(0, 20000), decision, denialReason ?? null, status, Date.now(),
  );
  return id;
}

function deny(db: Db, ctx: ToolCtx, turnIndex: number, tool: string, args: Record<string, unknown>, reason: string): DispatchOutcome {
  const toolCallId = recordCall(db, ctx, turnIndex, tool, args, 'denied', 'denied', reason);
  emitEvent(db, {
    type: 'tool.denied', orgId: ctx.orgId, executionId: ctx.executionId, taskId: ctx.taskId, agentKey: ctx.agentKey,
    payload: { tool, reason, toolCallId },
  });
  return {
    decision: 'denied',
    toolCallId,
    result: { ok: false, error: `PERMISSION DENIED: ${reason}. This decision is enforced by the backend; adapt your approach within policy or fail honestly.` },
  };
}

export async function dispatchTool(
  db: Db,
  ctx: ToolCtx,
  policy: RolePolicy,
  turnIndex: number,
  toolName: string,
  rawArgs: Record<string, unknown>,
): Promise<DispatchOutcome> {
  const args: Record<string, unknown> = { ...rawArgs };

  const tool = getTool(toolName);
  if (!tool) return deny(db, ctx, turnIndex, toolName, args, `tool "${toolName}" does not exist`);
  if (!policy.tools.includes(toolName)) {
    return deny(db, ctx, turnIndex, toolName, args, `tool "${toolName}" is not in the ${ctx.agentKey} agent's tool policy`);
  }

  const schemaErrors = validate(tool.schema, args);
  if (schemaErrors.length > 0) {
    return deny(db, ctx, turnIndex, toolName, args,
      `invalid arguments: ${schemaErrors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  }

  // Path containment + glob policy for filesystem tools.
  const pathEffect = PATH_TOOLS[toolName];
  if (pathEffect) {
    const rawPath = toolName === 'search' ? String(args.path ?? '.') : String(args.path);
    mkdirSync(ctx.workspaceRoot, { recursive: true });
    let resolved: { abs: string; rel: string };
    try {
      resolved = resolveWorkspacePath(ctx.workspaceRoot, rawPath === '' ? '.' : rawPath);
    } catch (err) {
      return deny(db, ctx, turnIndex, toolName, args, err instanceof Error ? err.message : String(err));
    }
    const relForPolicy = resolved.rel === '' ? '.' : resolved.rel;
    if (pathEffect === 'write' && !pathAllowed(policy, relForPolicy, 'write')) {
      return deny(db, ctx, turnIndex, toolName, args,
        `path "${relForPolicy}" is outside the ${ctx.agentKey} agent's writable paths [${policy.paths.write.join(', ') || 'none'}]`);
    }
    if (pathEffect === 'read' && relForPolicy !== '.' && !pathAllowed(policy, relForPolicy, 'read')) {
      return deny(db, ctx, turnIndex, toolName, args,
        `path "${relForPolicy}" is outside the ${ctx.agentKey} agent's readable paths [${policy.paths.read.join(', ') || 'none'}]`);
    }
    args.__abs = resolved.abs;
    args.__rel = relForPolicy;
  }

  if (toolName === 'run_command' && !commandAllowed(policy, String(args.cmd))) {
    return deny(db, ctx, turnIndex, toolName, args,
      `command "${String(args.cmd)}" is not in the ${ctx.agentKey} agent's command allowlist [${policy.commands.map((c) => [c.bin, ...(c.argsPrefix ?? [])].join(' ')).join(', ') || 'none'}]`);
  }

  // Approval gate.
  if (approvalRequired(policy, toolName, args)) {
    const toolCallId = recordCall(db, ctx, turnIndex, toolName, args, 'approval_required', 'pending_approval');
    const approvalId = ulid('apr');
    db.run(
      `INSERT INTO approvals (id, tool_call_id, execution_id, task_id, summary, requested_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      approvalId, toolCallId, ctx.executionId, ctx.taskId,
      `${ctx.agentKey}: ${toolName} — ${approvalSubject(toolName, args)}`, Date.now(),
    );
    emitEvent(db, {
      type: 'approval.requested', orgId: ctx.orgId, executionId: ctx.executionId, taskId: ctx.taskId, agentKey: ctx.agentKey,
      payload: { approvalId, toolCallId, tool: toolName, subject: approvalSubject(toolName, args) },
    });
    return {
      decision: 'approval_required',
      toolCallId,
      approvalId,
      result: { ok: false, data: { status: 'approval_pending' }, error: 'owner approval required; execution paused until decided' },
    };
  }

  // Execute.
  const toolCallId = recordCall(db, ctx, turnIndex, toolName, args, 'allowed', 'running');
  return executeToolCall(db, ctx, toolCallId, toolName, args);
}

/** Runs an allowed (or just-approved) tool call and records its outcome. */
export async function executeToolCall(
  db: Db,
  ctx: ToolCtx,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<DispatchOutcome> {
  const tool = getTool(toolName);
  if (!tool) {
    db.run(`UPDATE tool_calls SET status = 'failed', result_summary = ?, finished_at = ? WHERE id = ?`,
      'tool vanished from registry', Date.now(), toolCallId);
    return { decision: 'allowed', toolCallId, result: { ok: false, error: 'tool missing' } };
  }

  let result: ToolResult;
  try {
    result = await Promise.race([
      tool.run(args, ctx),
      new Promise<ToolResult>((_, reject) =>
        setTimeout(() => reject(new Error(`tool timed out after ${ctx.cfg.toolTimeoutMs}ms`)), ctx.cfg.toolTimeoutMs).unref(),
      ),
    ]);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Spill oversized results to an artifact and return a reference.
  let resultArtifactId: string | null = null;
  const serialized = JSON.stringify(result.data ?? {});
  if (serialized.length > ctx.cfg.toolResultInlineLimit) {
    const stored = storeArtifact(
      { db, artifactsDir: ctx.artifactsDir, orgId: ctx.orgId },
      { taskId: ctx.taskId, executionId: ctx.executionId, agentKey: ctx.agentKey, name: `tool-output-${toolCallId}.json`, kind: 'tool_output', content: serialized },
    );
    resultArtifactId = stored.id;
    result = {
      ok: result.ok,
      error: result.error,
      data: {
        spilled_to_artifact: stored.id,
        note: `output was ${serialized.length} chars; full content stored as artifact ${stored.id} (read_artifact by id if needed)`,
        preview: serialized.slice(0, 2000),
      },
    };
  }

  db.run(
    `UPDATE tool_calls SET status = ?, result_summary = ?, result_artifact_id = ?, finished_at = ? WHERE id = ?`,
    result.ok ? 'succeeded' : 'failed',
    (result.error ?? JSON.stringify(result.data ?? {})).slice(0, 2000),
    resultArtifactId, Date.now(), toolCallId,
  );
  emitEvent(db, {
    type: result.ok ? 'tool.succeeded' : 'tool.failed',
    orgId: ctx.orgId, executionId: ctx.executionId, taskId: ctx.taskId, agentKey: ctx.agentKey,
    payload: { toolCallId, tool: toolName, ok: result.ok, error: result.error ?? null },
  });
  return { decision: 'allowed', toolCallId, result };
}
