// Artifact store tools: content-addressed bytes under var/artifacts/<id>,
// metadata rows in the artifacts table. Agents exchange REFERENCES; content
// is fetched explicitly.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ulid } from '../../shared/ids.ts';
import type { Tool, ToolResult } from '../types.ts';

const MAX_INLINE = 200_000;

export const readArtifactTool: Tool = {
  name: 'read_artifact',
  description: 'Read a stored artifact by name (latest for this objective) or id. Args: {name} or {id}.',
  effects: 'read',
  schema: {
    type: 'object',
    properties: { name: { type: 'string' }, id: { type: 'string' } },
    additionalProperties: true,
  },
  run(args, ctx): Promise<ToolResult> {
    const row = args.id
      ? ctx.db.get<{ id: string; name: string; path: string; kind: string }>(
          'SELECT id, name, path, kind FROM artifacts WHERE id = ?', String(args.id))
      : ctx.db.get<{ id: string; name: string; path: string; kind: string }>(
          `SELECT a.id, a.name, a.path, a.kind FROM artifacts a
           JOIN tasks t ON t.id = a.task_id
           WHERE a.name = ? AND t.objective_id = ? ORDER BY a.created_at DESC LIMIT 1`,
          String(args.name ?? ''), ctx.objectiveId);
    if (!row) {
      return Promise.resolve({ ok: false, error: `artifact not found: ${String(args.name ?? args.id ?? '(no name/id given)')}` });
    }
    if (!existsSync(row.path)) {
      return Promise.resolve({ ok: false, error: `artifact ${row.name} metadata exists but bytes are missing from storage` });
    }
    const content = readFileSync(row.path, 'utf8');
    return Promise.resolve({
      ok: true,
      data: { id: row.id, name: row.name, kind: row.kind, content: content.slice(0, MAX_INLINE), truncated: content.length > MAX_INLINE },
    });
  },
};

export function storeArtifact(
  ctx: { db: import('../types.ts').ToolCtx['db']; artifactsDir: string; orgId: string },
  meta: { taskId: string | null; executionId: string | null; agentKey: string | null; name: string; kind: string; content: string },
): { id: string; sha256: string; size: number } {
  const id = ulid('art');
  mkdirSync(ctx.artifactsDir, { recursive: true });
  const path = join(ctx.artifactsDir, id);
  writeFileSync(path, meta.content, 'utf8');
  const hash = createHash('sha256').update(meta.content, 'utf8').digest('hex');
  const size = Buffer.byteLength(meta.content);
  ctx.db.run(
    `INSERT INTO artifacts (id, org_id, task_id, execution_id, agent_key, name, kind, path, content_hash, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, ctx.orgId, meta.taskId, meta.executionId, meta.agentKey, meta.name, meta.kind, path, hash, size, Date.now(),
  );
  return { id, sha256: hash, size };
}

export const writeArtifactTool: Tool = {
  name: 'write_artifact',
  description: 'Store a deliverable artifact for this task. Args: {name, content, kind?}. Overwrimtes nothing; creates a new version under the same name.',
  effects: 'write',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[\\w][\\w. -]*$' },
      content: { type: 'string', minLength: 1 },
      kind: { type: 'string' },
    },
    required: ['name', 'content'],
    additionalProperties: true,
  },
  run(args, ctx): Promise<ToolResult> {
    const stored = storeArtifact(ctx, {
      taskId: ctx.taskId,
      executionId: ctx.executionId,
      agentKey: ctx.agentKey,
      name: String(args.name),
      kind: typeof args.kind === 'string' ? args.kind : 'document',
      content: String(args.content),
    });
    return Promise.resolve({ ok: true, data: { id: stored.id, name: args.name, sha256: stored.sha256, size_bytes: stored.size } });
  },
};
