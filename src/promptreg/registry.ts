// PromptRegistry: prompt files under prompts/ are the seed source; the DB is
// the versioned system of record. Seeding is idempotent (sha256 change
// detection creates a new version only when content changed). Core and task
// prompts auto-activate; AGENT prompt versions land as 'candidate' and only
// become active through eval promotion (src/evals/promote.ts) — which is also
// what flips the agent's lifecycle to 'active'.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../shared/db.ts';
import { ulid } from '../shared/ids.ts';
import { emitEvent, audit } from '../shared/events.ts';

export type PromptScope = 'core' | 'agent' | 'task';

export interface PromptVersionRow {
  id: string;
  prompt_id: string;
  version: number;
  content: string;
  content_hash: string;
  status: string;
  evaluation_score: number | null;
  rollback_of: string | null;
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function ensurePrompt(db: Db, scope: PromptScope, key: string): string {
  const existing = db.get<{ id: string }>('SELECT id FROM prompts WHERE scope = ? AND key = ?', scope, key);
  if (existing) return existing.id;
  const id = ulid('prm');
  db.run('INSERT INTO prompts (id, scope, key) VALUES (?, ?, ?)', id, scope, key);
  return id;
}

export interface SeedResult {
  scope: PromptScope;
  key: string;
  action: 'unchanged' | 'created' | 'new_version';
  versionId: string;
  version: number;
}

export function seedPromptFile(db: Db, scope: PromptScope, key: string, content: string): SeedResult {
  const hash = sha256(content);
  const now = Date.now();
  return db.transaction(() => {
    const promptId = ensurePrompt(db, scope, key);
    const latest = db.get<PromptVersionRow>(
      'SELECT * FROM prompt_versions WHERE prompt_id = ? ORDER BY version DESC LIMIT 1',
      promptId,
    );
    if (latest && latest.content_hash === hash) {
      return { scope, key, action: 'unchanged' as const, versionId: latest.id, version: latest.version };
    }
    const version = (latest?.version ?? 0) + 1;
    const id = ulid('pv');
    // Core/task prompts activate immediately; agent prompts stay candidates
    // until they pass their eval suite.
    const status = scope === 'agent' ? 'candidate' : 'active';
    db.run(
      `INSERT INTO prompt_versions (id, prompt_id, version, content, content_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, promptId, version, content, hash, status, now, now,
    );
    if (scope !== 'agent' && latest) {
      db.run(`UPDATE prompt_versions SET status = 'archived', updated_at = ? WHERE id = ?`, now, latest.id);
    }
    return { scope, key, action: latest ? ('new_version' as const) : ('created' as const), versionId: id, version };
  });
}

export function seedPromptsFromDisk(db: Db, promptsDir: string): SeedResult[] {
  const results: SeedResult[] = [];
  const scopes: { scope: PromptScope; dir: string }[] = [
    { scope: 'core', dir: join(promptsDir, 'core') },
    { scope: 'agent', dir: join(promptsDir, 'agents') },
    { scope: 'task', dir: join(promptsDir, 'tasks') },
  ];
  for (const { scope, dir } of scopes) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    } catch {
      continue; // directory not created yet
    }
    for (const file of files) {
      const key = file.replace(/\.md$/, '');
      const content = readFileSync(join(dir, file), 'utf8');
      results.push(seedPromptFile(db, scope, key, content));
    }
  }
  return results;
}

/**
 * First-boot activation: agents ship with baseline prompts and must be usable
 * before any eval has run. Without this, a fresh deployment where
 * `npm run eval -- --promote` was skipped (or scored under the gate) has NO
 * active CEO prompt — every planning attempt crashes — and no assignable
 * agents — every plan step is rejected. Evals still gate every LATER prompt
 * version; this only activates the shipped baseline when nothing is active.
 */
export function activateBaselineAgentPrompts(db: Db, orgId: string): string[] {
  // Strictly virgin agents only: no active version AND no eval run ever
  // recorded. An agent that has entered the eval flow (even failing the
  // gate) stays gated — auto-activating there would bypass the eval harness
  // for edited prompt files. This is a first-boot bootstrap, not a backdoor.
  const rows = db.all<{ key: string; version_id: string }>(
    `SELECT a.key, pv.id AS version_id FROM agents a
     JOIN prompts p ON p.scope = 'agent' AND p.key = a.key
     JOIN prompt_versions pv ON pv.prompt_id = p.id
     WHERE a.active_prompt_version_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM eval_runs er WHERE er.agent_key = a.key)
       AND pv.version = (SELECT MAX(version) FROM prompt_versions WHERE prompt_id = p.id)`,
  );
  const now = Date.now();
  const activated: string[] = [];
  for (const row of rows) {
    const won = db.transaction(() => {
      // Guarded for the server/worker boot race: only the process that wins
      // the conditional UPDATE emits the event.
      const changed = db.run(
        `UPDATE agents SET lifecycle = 'active', active_prompt_version_id = ?, updated_at = ?
         WHERE key = ? AND active_prompt_version_id IS NULL`,
        row.version_id, now, row.key,
      );
      if (Number(changed.changes) === 0) return false;
      db.run(`UPDATE prompt_versions SET status = 'active', updated_at = ? WHERE id = ?`, now, row.version_id);
      emitEvent(db, {
        type: 'prompt.promoted', orgId, agentKey: row.key,
        payload: { versionId: row.version_id, baseline: true },
      });
      audit(db, orgId, 'boot', 'prompt.activate_baseline', 'prompt_version', row.version_id, { agentKey: row.key });
      return true;
    });
    if (won) activated.push(row.key);
  }
  return activated;
}

/** Ordered core files forming the shared immutable core. Order is part of the contract. */
export const CORE_ORDER = [
  'identity',
  'truth',
  'execution',
  'delegation',
  'permissions',
  'security',
  'memory',
  'verification',
  'communication',
  'output-contract',
] as const;

export interface CoreBundle {
  text: string;
  hash: string;
  versionIds: string[];
}

export function getActiveCoreBundle(db: Db): CoreBundle {
  const parts: string[] = [];
  const hashes: string[] = [];
  const versionIds: string[] = [];
  for (const key of CORE_ORDER) {
    const row = db.get<PromptVersionRow>(
      `SELECT pv.* FROM prompt_versions pv JOIN prompts p ON p.id = pv.prompt_id
       WHERE p.scope = 'core' AND p.key = ? AND pv.status = 'active'
       ORDER BY pv.version DESC LIMIT 1`,
      key,
    );
    if (!row) throw new Error(`core prompt missing or inactive: ${key} (run npm run seed)`);
    parts.push(row.content);
    hashes.push(row.content_hash);
    versionIds.push(row.id);
  }
  return { text: parts.join('\n\n'), hash: sha256(hashes.join('|')), versionIds };
}

export function getActiveAgentPrompt(db: Db, agentKey: string): PromptVersionRow {
  const agent = db.get<{ active_prompt_version_id: string | null }>(
    'SELECT active_prompt_version_id FROM agents WHERE key = ?',
    agentKey,
  );
  if (!agent?.active_prompt_version_id) {
    throw new Error(`agent ${agentKey} has no active prompt version (not yet promoted through evals)`);
  }
  const row = db.get<PromptVersionRow>('SELECT * FROM prompt_versions WHERE id = ?', agent.active_prompt_version_id);
  if (!row) throw new Error(`agent ${agentKey} active prompt version ${agent.active_prompt_version_id} missing`);
  return row;
}

export function getLatestAgentPromptVersion(db: Db, agentKey: string): PromptVersionRow | undefined {
  return db.get<PromptVersionRow>(
    `SELECT pv.* FROM prompt_versions pv JOIN prompts p ON p.id = pv.prompt_id
     WHERE p.scope = 'agent' AND p.key = ? ORDER BY pv.version DESC LIMIT 1`,
    agentKey,
  );
}

export function getTaskTemplate(db: Db, key: string): string | undefined {
  const row = db.get<{ content: string }>(
    `SELECT pv.content FROM prompt_versions pv JOIN prompts p ON p.id = pv.prompt_id
     WHERE p.scope = 'task' AND p.key = ? AND pv.status = 'active' ORDER BY pv.version DESC LIMIT 1`,
    key,
  );
  return row?.content;
}
