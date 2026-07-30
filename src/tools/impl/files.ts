// Workspace file tools. Paths arrive already resolved+policy-checked by
// dispatch (passed as args.__abs / args.__rel).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type { Tool, ToolResult } from '../types.ts';
import { storeArtifact } from './artifacts.ts';

const MAX_READ = 200_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'var']);

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read a file from the workspace. Args: {path}. Returns its content (truncated past 200KB).',
  effects: 'read',
  schema: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: true },
  run(args): Promise<ToolResult> {
    const abs = String(args.__abs);
    if (!existsSync(abs)) return Promise.resolve({ ok: false, error: `file not found: ${String(args.path)}` });
    if (statSync(abs).isDirectory()) return Promise.resolve({ ok: false, error: `${String(args.path)} is a directory; use list_dir` });
    const content = readFileSync(abs, 'utf8');
    return Promise.resolve({
      ok: true,
      data: {
        path: args.path,
        content: content.slice(0, MAX_READ),
        truncated: content.length > MAX_READ,
        size: content.length,
      },
    });
  },
};

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Create or overwrite a file in the workspace (within your writable paths). Args: {path, content}. A file matching one of the task\'s expected artifacts is registered as that artifact automatically.',
  effects: 'write',
  schema: {
    type: 'object',
    properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' } },
    required: ['path', 'content'],
    additionalProperties: true,
  },
  run(args, ctx): Promise<ToolResult> {
    const abs = String(args.__abs);
    mkdirSync(dirname(abs), { recursive: true });
    const content = String(args.content);
    writeFileSync(abs, content, 'utf8');
    // The task packet says expected artifacts may be created "via
    // write_artifact or write_file" — honor that: a workspace file whose
    // path/basename matches an expected artifact IS the deliverable, so
    // register it (verification resolves artifacts through the DB).
    let registeredArtifactId: string | null = null;
    try {
      const task = ctx.taskId
        ? ctx.db.get<{ expected_artifacts: string }>('SELECT expected_artifacts FROM tasks WHERE id = ?', ctx.taskId)
        : undefined;
      const expected = task ? (JSON.parse(task.expected_artifacts || '[]') as string[]) : [];
      const rel = String(args.__rel ?? args.path);
      const matchName = expected.includes(rel) ? rel : expected.includes(basename(rel)) ? basename(rel) : null;
      if (matchName) {
        registeredArtifactId = storeArtifact(
          { db: ctx.db, artifactsDir: ctx.artifactsDir, orgId: ctx.orgId },
          { taskId: ctx.taskId, executionId: ctx.executionId, agentKey: ctx.agentKey, name: matchName, kind: 'file', content },
        ).id;
      }
    } catch { /* registration is additive; the write itself already succeeded */ }
    return Promise.resolve({
      ok: true,
      data: {
        path: args.path, bytes_written: Buffer.byteLength(content),
        ...(registeredArtifactId ? { registered_as_artifact: registeredArtifactId } : {}),
      },
    });
  },
};

export const editFileTool: Tool = {
  name: 'edit_file',
  description: 'Make a precise find-and-replace edit to an existing file (within your writable paths). Args: {path, old_string, new_string, replace_all?}. old_string must match EXACTLY (including whitespace) and must be unique in the file unless replace_all is true.',
  effects: 'write',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1 },
      old_string: { type: 'string', minLength: 1 },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: true,
  },
  run(args): Promise<ToolResult> {
    const abs = String(args.__abs);
    if (!existsSync(abs)) return Promise.resolve({ ok: false, error: `file not found: ${String(args.path)}` });
    if (statSync(abs).isDirectory()) return Promise.resolve({ ok: false, error: `${String(args.path)} is a directory` });
    const content = readFileSync(abs, 'utf8');
    const oldStr = String(args.old_string);
    const occurrences = content.split(oldStr).length - 1;
    if (occurrences === 0) return Promise.resolve({ ok: false, error: 'old_string not found in file — it must match exactly, including whitespace' });
    if (occurrences > 1 && !args.replace_all) {
      return Promise.resolve({ ok: false, error: `old_string appears ${occurrences} times — make it more specific, or pass replace_all: true` });
    }
    const newStr = String(args.new_string);
    const updated = args.replace_all ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
    writeFileSync(abs, updated, 'utf8');
    return Promise.resolve({ ok: true, data: { path: args.path, replacements: args.replace_all ? occurrences : 1 } });
  },
};

export const listDirTool: Tool = {
  name: 'list_dir',
  description: 'List entries of a workspace directory. Args: {path} ("." for the workspace root).',
  effects: 'read',
  schema: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: true },
  run(args): Promise<ToolResult> {
    const abs = String(args.__abs);
    if (!existsSync(abs)) return Promise.resolve({ ok: false, error: `directory not found: ${String(args.path)}` });
    const entries = readdirSync(abs).map((name) => {
      const st = statSync(join(abs, name));
      return { name, type: st.isDirectory() ? 'dir' : 'file', size: st.isDirectory() ? undefined : st.size };
    });
    return Promise.resolve({ ok: true, data: { path: args.path, entries } });
  },
};

export const searchTool: Tool = {
  name: 'search',
  description: 'Regex search across workspace files. Args: {pattern, path?, max_results?}. Returns matching lines with file+line.',
  effects: 'read',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', minLength: 1 },
      path: { type: 'string' },
      max_results: { type: 'integer', minimum: 1, maximum: 200 },
    },
    required: ['pattern'],
    additionalProperties: true,
  },
  run(args): Promise<ToolResult> {
    let re: RegExp;
    try {
      re = new RegExp(String(args.pattern));
    } catch (err) {
      return Promise.resolve({ ok: false, error: `invalid regex: ${err instanceof Error ? err.message : String(err)}` });
    }
    const root = String(args.__abs);
    const max = Number(args.max_results ?? 50);
    const matches: { file: string; line: number; text: string }[] = [];
    const walk = (dir: string, rel: string): void => {
      if (matches.length >= max || !existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        if (matches.length >= max) return;
        if (SKIP_DIRS.has(name)) continue;
        const absChild = join(dir, name);
        const relChild = rel ? `${rel}/${name}` : name;
        const st = statSync(absChild);
        if (st.isDirectory()) walk(absChild, relChild);
        else if (st.size < 1_000_000) {
          const lines = readFileSync(absChild, 'utf8').split('\n');
          for (let i = 0; i < lines.length && matches.length < max; i++) {
            if (re.test(lines[i])) matches.push({ file: relChild, line: i + 1, text: lines[i].slice(0, 300) });
          }
        }
      }
    };
    const rootStat = existsSync(root) ? statSync(root) : null;
    if (rootStat?.isFile()) {
      const lines = readFileSync(root, 'utf8').split('\n');
      const rel = String(args.__rel);
      for (let i = 0; i < lines.length && matches.length < max; i++) {
        if (re.test(lines[i])) matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 300) });
      }
    } else {
      walk(root, String(args.__rel) === '.' ? '' : String(args.__rel));
    }
    return Promise.resolve({ ok: true, data: { pattern: args.pattern, matches, capped: matches.length >= max } });
  },
};
