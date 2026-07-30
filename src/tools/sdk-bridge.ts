// Bridges the Claude Agent SDK's in-process custom-tool mechanism
// (createSdkMcpServer) to dispatchTool() — the SAME single enforcement
// point the worker pipeline already uses (path containment, command
// allowlisting, approvals, audit, timeout, output limits). This closes the
// gap where the live SDK session (parent + subagents) previously bypassed
// the dispatcher entirely via the SDK's native raw Bash / unrestricted
// Write / unrestricted Edit — those three built-in tools are no longer
// granted to any SIRA agent (see src/sira/agents.ts, src/sira/session.ts);
// write_file / edit_file / run_command here are their replacements, and go
// through EXACTLY the same policy/audit path a worker task's tool call
// does. Native Read/Glob/Grep remain (read-only, and now path-checked in
// session.ts's canUseTool) — no reason to replace what's already safe.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Db } from '../shared/db.ts';
import type { SystemConfig, RolePolicy } from '../shared/config.ts';
import { dispatchTool, executeToolCall } from './dispatch.ts';
import type { ToolCtx, ToolResult } from './types.ts';

function toCallToolResult(result: ToolResult): { content: { type: 'text'; text: string }[]; isError: boolean } {
  return {
    content: [{ type: 'text', text: JSON.stringify(result.ok ? (result.data ?? {}) : { error: result.error }) }],
    isError: !result.ok,
  };
}

/**
 * Runs one tool call through the full dispatcher, and — mirroring
 * SiraSession's existing Bash-approval flow — blocks (polling, same
 * pattern) until the owner decides when the policy requires approval,
 * rather than surfacing "approval_pending" as if it were a final answer.
 */
async function runAndAwaitApproval(
  db: Db, ctx: ToolCtx, policy: RolePolicy, turnIndex: number, toolName: string, args: Record<string, unknown>,
): Promise<ToolResult> {
  const outcome = await dispatchTool(db, ctx, policy, turnIndex, toolName, args);
  if (outcome.decision !== 'approval_required') return outcome.result;
  // dispatchTool always sets approvalId when decision is 'approval_required'
  // — see dispatch.ts:120-146. The type is optional only because the same
  // interface also covers 'allowed'/'denied', where it's genuinely absent.
  const approvalId = outcome.approvalId as string;
  const deadline = Date.now() + ctx.cfg.approvalTimeoutMs;
  for (;;) {
    const row = db.get<{ status: string }>('SELECT status FROM approvals WHERE id = ?', approvalId);
    // Use outcome.args (dispatchTool's own resolved copy — e.g. __abs/__rel
    // for path tools), never the caller's original `args`: dispatchTool
    // never mutates the object it was handed, only its own internal copy.
    if (row?.status === 'approved') return (await executeToolCall(db, ctx, outcome.toolCallId, toolName, outcome.args)).result;
    if (row?.status === 'rejected') return { ok: false, error: 'the owner declined this action' };
    if (Date.now() > deadline) {
      db.run(`UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'`, Date.now(), approvalId);
      return { ok: false, error: 'approval timed out — the owner did not respond in time' };
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

export interface RoleToolServerDeps {
  db: Db;
  cfg: SystemConfig;
  policy: RolePolicy;
  agentKey: string;
  workspaceRoot: string;
  artifactsDir: string;
  orgId: string;
  conversationId: string;
}

export interface RoleToolServer {
  server: ReturnType<typeof createSdkMcpServer>;
  /** The exact function every registered tool's handler calls — exposed
   *  directly so the security boundary (policy/approval/audit enforcement)
   *  is unit-testable without needing a live SDK session or reaching into
   *  the MCP server's internals. */
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

/**
 * One in-process MCP server per role, bound to that role's own ToolCtx
 * (agentKey, policy, workspace) via closure — needed because the SDK's
 * generic tool-handler signature carries no caller identity, unlike
 * canUseTool's `agentID`. Registers every dispatcher-backed tool
 * unconditionally; AgentDefinition.tools (built from the SAME policy in
 * src/sira/agents.ts) controls which of them each role's model actually
 * sees — dispatchTool's own `policy.tools.includes()` check is a second,
 * redundant layer under that, not the primary gate.
 */
export function buildRoleToolServer(deps: RoleToolServerDeps): RoleToolServer {
  let turnIndex = 0;
  const ctx: ToolCtx = {
    db: deps.db, cfg: deps.cfg, orgId: deps.orgId,
    objectiveId: null, taskId: null, executionId: null, conversationId: deps.conversationId,
    agentKey: deps.agentKey, workspaceRoot: deps.workspaceRoot, artifactsDir: deps.artifactsDir,
  };
  const callTool = (toolName: string, args: Record<string, unknown>): Promise<ToolResult> =>
    runAndAwaitApproval(deps.db, ctx, deps.policy, turnIndex++, toolName, args);
  const run = (toolName: string, args: Record<string, unknown>): Promise<ReturnType<typeof toCallToolResult>> =>
    callTool(toolName, args).then(toCallToolResult);

  const server = createSdkMcpServer({
    name: `sira-${deps.agentKey}`,
    tools: [
      tool('write_file', 'Create or overwrite a file within your writable paths. A file matching one of the task\'s expected artifacts is registered as that artifact automatically.',
        { path: z.string().min(1), content: z.string() },
        (a) => run('write_file', a)),
      tool('edit_file', 'Make a precise find-and-replace edit to an existing file within your writable paths. old_string must match exactly (including whitespace) and must be unique unless replace_all is true.',
        { path: z.string().min(1), old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().optional() },
        (a) => run('edit_file', a)),
      tool('run_command', 'Run an allowlisted command (no shell — no pipes, redirection, substitution, or interpreter -e/-c code execution). Args: cmd is the full command line (e.g. "npm run test:unit"), space-separated.',
        { cmd: z.string().min(1), timeout_ms: z.number().int().min(1000).max(600000).optional() },
        (a) => run('run_command', a)),
      tool('read_artifact', 'Read a stored artifact by name (latest for this objective/conversation) or id.',
        { name: z.string().optional(), id: z.string().optional() },
        (a) => run('read_artifact', a)),
      tool('write_artifact', 'Store a deliverable artifact. Creates a new version under the same name; overwrites nothing.',
        { name: z.string().min(1).max(120), content: z.string().min(1), kind: z.string().optional() },
        (a) => run('write_artifact', a)),
      tool('memory_search', 'Search stored company/agent/objective memories.',
        { query: z.string().min(1), scope: z.enum(['company', 'agent', 'objective']).optional() },
        (a) => run('memory_search', a)),
      tool('memory_write', 'Persist one durable fact, keyed within a scope (default: agent). Upserts by key within scope.',
        { key: z.string().min(1).max(120), content: z.string().min(1).max(4000), scope: z.enum(['company', 'agent', 'objective']).optional() },
        (a) => run('memory_write', a)),
      tool('task_note', 'Record a short operational note on the timeline, visible to the owner.',
        { note: z.string().min(1).max(1000) },
        (a) => run('task_note', a)),
    ],
  });
  return { server, callTool };
}
