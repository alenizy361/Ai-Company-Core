// Memory tools: durable operational knowledge, keyed and scoped.
import { ulid } from '../../shared/ids.ts';
import type { Tool, ToolResult } from '../types.ts';

export const memorySearchTool: Tool = {
  name: 'memory_search',
  description: 'Search stored memories. Args: {query, scope?} (scope: company|agent|objective). Returns matching items.',
  effects: 'read',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1 },
      scope: { enum: ['company', 'agent', 'objective'] },
    },
    required: ['query'],
    additionalProperties: true,
  },
  run(args, ctx): Promise<ToolResult> {
    const like = `%${String(args.query).replace(/[%_]/g, '')}%`;
    const scopeFilter = typeof args.scope === 'string' ? 'AND scope = ?' : '';
    const params: (string | number)[] = [ctx.orgId, like, like];
    if (scopeFilter) params.push(String(args.scope));
    const rows = ctx.db.all<{ scope: string; agent_key: string | null; key: string; content: string; updated_at: number }>(
      `SELECT scope, agent_key, key, content, updated_at FROM memories
       WHERE org_id = ? AND (key LIKE ? OR content LIKE ?) ${scopeFilter}
       ORDER BY updated_at DESC LIMIT 10`,
      ...params,
    );
    return Promise.resolve({ ok: true, data: { query: args.query, results: rows } });
  },
};

export const memoryWriteTool: Tool = {
  name: 'memory_write',
  description: 'Persist one durable fact. Args: {key, content, scope?} (default scope: agent). Upserts by key within scope.',
  effects: 'write',
  schema: {
    type: 'object',
    properties: {
      key: { type: 'string', minLength: 1, maxLength: 120 },
      content: { type: 'string', minLength: 1, maxLength: 4000 },
      scope: { enum: ['company', 'agent', 'objective'] },
    },
    required: ['key', 'content'],
    additionalProperties: true,
  },
  run(args, ctx): Promise<ToolResult> {
    const scope = typeof args.scope === 'string' ? args.scope : 'agent';
    const agentKey = scope === 'agent' ? ctx.agentKey : null;
    const objectiveId = scope === 'objective' ? ctx.objectiveId : null;
    const now = Date.now();
    const existing = ctx.db.get<{ id: string }>(
      `SELECT id FROM memories WHERE org_id = ? AND scope = ? AND key = ?
         AND (agent_key IS ? ) AND (objective_id IS ?)`,
      ctx.orgId, scope, String(args.key), agentKey, objectiveId,
    );
    if (existing) {
      ctx.db.run('UPDATE memories SET content = ?, source_execution_id = ?, updated_at = ? WHERE id = ?',
        String(args.content), ctx.executionId, now, existing.id);
      return Promise.resolve({ ok: true, data: { key: args.key, scope, updated: true } });
    }
    ctx.db.run(
      `INSERT INTO memories (id, org_id, agent_key, scope, objective_id, key, content, source_execution_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ulid('mem'), ctx.orgId, agentKey, scope, objectiveId, String(args.key), String(args.content), ctx.executionId, now, now,
    );
    return Promise.resolve({ ok: true, data: { key: args.key, scope, created: true } });
  },
};

export const taskNoteTool: Tool = {
  name: 'task_note',
  description: 'Record a short operational note on the task timeline (visible to the owner). Args: {note}.',
  effects: 'write',
  schema: {
    type: 'object',
    properties: { note: { type: 'string', minLength: 1, maxLength: 1000 } },
    required: ['note'],
    additionalProperties: true,
  },
  run(args, ctx): Promise<ToolResult> {
    ctx.db.run(
      `INSERT INTO execution_events (id, org_id, execution_id, task_id, agent_key, type, payload, created_at)
       VALUES (?, ?, ?, ?, ?, 'task.note', ?, ?)`,
      ulid('ev'), ctx.orgId, ctx.executionId, ctx.taskId, ctx.agentKey, JSON.stringify({ note: String(args.note) }), Date.now(),
    );
    return Promise.resolve({ ok: true, data: { recorded: true } });
  },
};
