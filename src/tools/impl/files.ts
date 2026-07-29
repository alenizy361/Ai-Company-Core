// Workspace file tools. Paths arrive already resolved+policy-checked by
// dispatch (passed as args.__abs / args.__rel).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Tool, ToolResult } from '../types.ts';

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
  description: 'Create or overwrite a file in the workspace (within your writable paths). Args: {path, content}.',
  effects: 'write',
  schema: {
    type: 'object',
    properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' } },
    required: ['path', 'content'],
    additionalProperties: true,
  },
  run(args): Promise<ToolResult> {
    const abs = String(args.__abs);
    mkdirSync(dirname(abs), { recursive: true });
    const content = String(args.content);
    writeFileSync(abs, content, 'utf8');
    return Promise.resolve({ ok: true, data: { path: args.path, bytes_written: Buffer.byteLength(content) } });
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
