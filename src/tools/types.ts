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
  objectiveId: string;
  taskId: string;
  executionId: string;
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
