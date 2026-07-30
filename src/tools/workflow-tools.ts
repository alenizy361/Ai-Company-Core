// MCP tool server exposing saved browser/AT-SPI automation sequences to the
// parent SIRA session only — workflow_save/list are DB-direct (pure
// metadata, same pattern as read_artifact/write_artifact); workflow_run
// goes through the desktop-bridge daemon (only it holds live backend
// instances) via callWorkflowRun(). callTool exposed for direct testing,
// same convention as buildDesktopToolServer/buildBrowserToolServer.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Db } from '../shared/db.ts';
import type { SystemConfig } from '../shared/config.ts';
import { saveWorkflow, listWorkflows, type WorkflowKind } from '../desktop-bridge/workflows/store.ts';
import { callWorkflowRun } from '../desktop-bridge/workflows/client.ts';
import { toCallToolResult } from './desktop-bridge-tools.ts';
import type { ToolResult } from './types.ts';

export interface WorkflowToolServerDeps {
  db: Db;
  cfg: SystemConfig;
  orgId: string;
  agentKey: string;
  conversationId: string;
}

export interface WorkflowToolServer {
  server: ReturnType<typeof createSdkMcpServer>;
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

export function buildWorkflowToolServer(deps: WorkflowToolServerDeps): WorkflowToolServer {
  const save = (args: { name: string; kind: WorkflowKind; signature: Record<string, string>; steps: { tool: string; args: Record<string, unknown> }[] }): ToolResult => {
    try {
      const { id } = saveWorkflow(deps.db, {
        orgId: deps.orgId, name: args.name, kind: args.kind, signature: args.signature, steps: args.steps,
        createdByAgentKey: deps.agentKey,
      });
      return { ok: true, data: { id } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const list = (args: { name_filter?: string }): ToolResult => {
    const rows = listWorkflows(deps.db, deps.orgId, args.name_filter);
    return {
      ok: true,
      data: {
        workflows: rows.map((r) => ({
          name: r.name, kind: r.kind, signature: JSON.parse(r.signature_json), stepCount: (JSON.parse(r.steps_json) as unknown[]).length,
          runCount: r.run_count, lastRunAt: r.last_run_at,
        })),
      },
    };
  };

  const run = (args: { name: string; params?: Record<string, string> }): Promise<ToolResult> =>
    callWorkflowRun(deps.cfg, { name: args.name, params: args.params ?? {}, agentKey: deps.agentKey, conversationId: deps.conversationId })
      .then((r) => ({ ok: r.ok, data: { stepsCompleted: r.stepsCompleted, totalSteps: r.totalSteps, results: r.results }, error: r.error }));

  const callTool = async (toolName: string, args: Record<string, unknown>): Promise<ToolResult> => {
    switch (toolName) {
      case 'save': return save(args as never);
      case 'list': return list(args as never);
      case 'run': return run(args as never);
      default: return { ok: false, error: `unknown workflow tool "${toolName}"` };
    }
  };

  const server = createSdkMcpServer({
    name: 'sira-workflows',
    tools: [
      tool('workflow_save',
        'Save a named sequence of browser_* or atspi_* tool calls for instant replay later, without a model call per step. Steps may NOT include desktop_* (coordinate-based) actions. A signature (urlPattern for browser, appName for atspi) is checked before replay — if it does not match the live state, zero steps run.',
        {
          name: z.string().min(1).max(200),
          kind: z.enum(['browser', 'atspi']),
          signature: z.record(z.string(), z.string()),
          steps: z.array(z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()) })).min(1).max(50),
        },
        (a) => Promise.resolve(toCallToolResult(save(a)))),
      tool('workflow_list', 'List saved workflows, optionally filtered by a name substring — check what exists and its signature before running or saving over it.',
        { name_filter: z.string().optional() },
        (a) => Promise.resolve(toCallToolResult(list(a)))),
      tool('workflow_run', 'Replay a saved workflow by name. Checks its signature against live state first — if it does not match, zero steps run and you get told why (act on that yourself, do not retry blindly).',
        { name: z.string().min(1), params: z.record(z.string(), z.string()).optional() },
        async (a) => toCallToolResult(await run(a))),
    ],
  });
  return { server, callTool };
}

export const WORKFLOW_TOOL_NAMES = ['workflow_save', 'workflow_list', 'workflow_run'];
