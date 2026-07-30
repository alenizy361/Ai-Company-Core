// Tool interface. Tools do the work; they never decide permissions —
// dispatch.ts has already resolved paths, checked policy, and recorded the
// call before a tool's run() is invoked.
import type { Db } from '../shared/db.ts';
import type { SystemConfig } from '../shared/config.ts';
import type { SchemaNode } from '../shared/jsonschema.ts';

export interface ToolCtx {
  db: Db;
  cfg: SystemConfig;
  orgId: string;
  /**
   * Null for a LIVE conversational tool call (the SDK parent session or one
   * of its subagents, outside any objective/task/execution) — conversationId
   * identifies it instead. The worker pipeline always sets all three.
   */
  objectiveId: string | null;
  taskId: string | null;
  executionId: string | null;
  conversationId: string | null;
  agentKey: string;
  workspaceRoot: string;
  artifactsDir: string;
}

export interface ToolResult {
  ok: boolean;
  /** JSON-serializable payload fed back to the model (possibly truncated/spilled by dispatch). */
  data?: Record<string, unknown>;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  effects: 'read' | 'write' | 'execute';
  schema: SchemaNode;
  run(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult>;
}
