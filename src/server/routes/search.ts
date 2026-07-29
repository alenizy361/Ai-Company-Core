// Global search across real entities. Plain LIKE over indexed-small tables —
// results always reference persisted rows the client can open directly.
import type { Db } from '../../shared/db.ts';
import type { Router } from '../router.ts';
import { json, errorJson } from '../router.ts';

export interface SearchResult {
  type: 'approval' | 'task' | 'objective' | 'agent' | 'artifact' | 'conversation' | 'message' | 'notification';
  id: string;
  title: string;
  snippet?: string;
  status?: string;
  lang?: string | null;
  at: number;
  ref: Record<string, string>;
  /** lower = more important; used for cross-type ordering */
  tier: number;
  prefix: boolean;
}

const PER_TABLE = 8;
const NON_TERMINAL_TASK = `('queued','waiting_for_dependency','blocked','running','waiting_for_tool','waiting_for_approval','verifying')`;

function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function searchAll(db: Db, q: string, limit: number): SearchResult[] {
  const pat = `%${escapeLike(q)}%`;
  const lowered = q.toLowerCase();
  const results: SearchResult[] = [];
  const prefix = (title: string): boolean => title.toLowerCase().startsWith(lowered);

  for (const row of db.all<{ id: string; summary: string; status: string; requested_at: number }>(
    `SELECT id, summary, status, requested_at FROM approvals WHERE summary LIKE ? ESCAPE '\\' ORDER BY requested_at DESC LIMIT ${PER_TABLE}`, pat)) {
    results.push({
      type: 'approval', id: row.id, title: row.summary, status: row.status, at: row.requested_at,
      ref: { approvalId: row.id }, tier: row.status === 'pending' ? 0 : 4, prefix: prefix(row.summary),
    });
  }
  for (const row of db.all<{ id: string; title: string; status: string; agent_key: string; objective_id: string; updated_at: number; nonterminal: number }>(
    `SELECT id, title, status, agent_key, objective_id, updated_at,
            (status IN ${NON_TERMINAL_TASK}) AS nonterminal
     FROM tasks WHERE title LIKE ? ESCAPE '\\' OR blocker LIKE ? ESCAPE '\\'
     ORDER BY nonterminal DESC, updated_at DESC LIMIT ${PER_TABLE}`, pat, pat)) {
    results.push({
      type: 'task', id: row.id, title: row.title, status: row.status, at: row.updated_at,
      ref: { taskId: row.id, objectiveId: row.objective_id, agentKey: row.agent_key },
      tier: row.nonterminal ? 1 : 4, prefix: prefix(row.title),
    });
  }
  for (const row of db.all<{ id: string; title: string; status: string; updated_at: number }>(
    `SELECT id, title, status, updated_at FROM objectives WHERE title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ${PER_TABLE}`, pat)) {
    const terminal = ['completed', 'failed', 'cancelled'].includes(row.status);
    results.push({
      type: 'objective', id: row.id, title: row.title, status: row.status, at: row.updated_at,
      ref: { objectiveId: row.id }, tier: terminal ? 4 : 1, prefix: prefix(row.title),
    });
  }
  for (const row of db.all<{ key: string; short: string; name_en: string; name_ar: string; lifecycle: string; updated_at: number }>(
    `SELECT key, short, name_en, name_ar, lifecycle, updated_at FROM agents
     WHERE key LIKE ? ESCAPE '\\' OR short LIKE ? ESCAPE '\\' OR name_en LIKE ? ESCAPE '\\' OR name_ar LIKE ? ESCAPE '\\'
     ORDER BY key LIMIT ${PER_TABLE}`, pat, pat, pat, pat)) {
    results.push({
      type: 'agent', id: row.key, title: row.name_en, snippet: row.name_ar, status: row.lifecycle,
      at: row.updated_at, ref: { agentKey: row.key }, tier: 2,
      prefix: prefix(row.name_en) || prefix(row.key) || prefix(row.name_ar),
    });
  }
  for (const row of db.all<{ id: string; name: string; kind: string; task_id: string | null; created_at: number }>(
    `SELECT id, name, kind, task_id, created_at FROM artifacts
     WHERE name LIKE ? ESCAPE '\\' OR kind LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ${PER_TABLE}`, pat, pat)) {
    results.push({
      type: 'artifact', id: row.id, title: row.name, snippet: row.kind, at: row.created_at,
      ref: { artifactId: row.id, ...(row.task_id ? { taskId: row.task_id } : {}) }, tier: 3, prefix: prefix(row.name),
    });
  }
  for (const row of db.all<{ id: string; title: string; updated_at: number }>(
    `SELECT id, title, updated_at FROM conversations WHERE title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ${PER_TABLE}`, pat)) {
    results.push({
      type: 'conversation', id: row.id, title: row.title, at: row.updated_at,
      ref: { conversationId: row.id }, tier: 4, prefix: prefix(row.title),
    });
  }
  for (const row of db.all<{ id: string; conversation_id: string; content: string; lang: string | null; created_at: number }>(
    `SELECT id, conversation_id, content, lang, created_at FROM messages
     WHERE content LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ${PER_TABLE}`, pat)) {
    const idx = row.content.toLowerCase().indexOf(lowered);
    const start = Math.max(0, idx - 30);
    results.push({
      type: 'message', id: row.id, title: row.content.slice(0, 60), lang: row.lang,
      snippet: (start > 0 ? '…' : '') + row.content.slice(start, start + 120),
      at: row.created_at, ref: { conversationId: row.conversation_id, messageId: row.id }, tier: 4, prefix: idx === 0,
    });
  }
  for (const row of db.all<{ id: string; kind: string; title: string; created_at: number }>(
    `SELECT id, kind, title, created_at FROM notifications
     WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ${PER_TABLE}`, pat, pat)) {
    results.push({
      type: 'notification', id: row.id, title: row.title, snippet: row.kind, at: row.created_at,
      ref: { notificationId: row.id }, tier: 4, prefix: prefix(row.title),
    });
  }

  results.sort((a, b) =>
    a.tier - b.tier
    || Number(b.prefix) - Number(a.prefix)
    || b.at - a.at,
  );
  return results.slice(0, limit);
}

export function registerSearchRoutes(router: Router, db: Db): void {
  router.get('/api/search', ({ res, query }) => {
    const q = (query.get('q') ?? '').trim();
    if (q.length < 2) return errorJson(res, 400, 'BAD_REQUEST', 'q must be at least 2 characters');
    const limit = Math.min(Math.max(Number(query.get('limit') ?? 25) || 25, 1), 50);
    const results = searchAll(db, q, limit).map(({ tier: _t, prefix: _p, ...rest }) => rest);
    json(res, 200, { q, results });
  });
}
