// Policy evaluation helpers: glob path matching with realpath containment
// (defeats ../ and symlink escapes), command allowlisting, approval matchers.
// Used ONLY by dispatch.ts — the single enforcement point.
import { realpathSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import type { RolePolicy } from '../shared/config.ts';

/** Minimal glob: ** crosses directories, * stays within a segment. */
export function globMatch(pattern: string, path: string): boolean {
  const DOUBLE = '__DOUBLE_STAR__';
  const esc = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .split('**').join(DOUBLE)
    .replace(/\*/g, '[^/]*')
    .split(DOUBLE).join('.*');
  return new RegExp(`^${esc}$`).test(path);
}

export function pathAllowed(policy: RolePolicy, relPath: string, effect: 'read' | 'write'): boolean {
  const patterns = effect === 'read' ? policy.paths.read : policy.paths.write;
  return patterns.some((p) => globMatch(p, relPath));
}

/**
 * Resolve an agent-supplied path against the workspace root and prove
 * containment. Returns the absolute path plus the workspace-relative path
 * used for glob checks. Throws with a policy-violation message otherwise.
 */
export function resolveWorkspacePath(workspaceRoot: string, agentPath: string): { abs: string; rel: string } {
  if (typeof agentPath !== 'string' || agentPath.length === 0) throw new Error('path must be a non-empty string');
  if (isAbsolute(agentPath)) throw new Error('absolute paths are not allowed; paths are workspace-relative');
  const rootReal = realpathSync(workspaceRoot);
  const abs = resolve(rootReal, agentPath);
  const rel = relative(rootReal, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes the workspace: ${agentPath}`);

  // Symlink defense: realpath the nearest existing ancestor and re-check.
  let probe = abs;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const probeReal = realpathSync(probe);
  const relReal = relative(rootReal, probeReal);
  if (relReal.startsWith('..') || isAbsolute(relReal)) {
    throw new Error(`path resolves outside the workspace via symlink: ${agentPath}`);
  }
  return { abs, rel: rel.split(sep).join('/') };
}

export function commandAllowed(policy: RolePolicy, cmd: string): boolean {
  const parts = cmd.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return false;
  return policy.commands.some((allowed) => {
    if (allowed.bin !== parts[0]) return false;
    const prefix = allowed.argsPrefix ?? [];
    return prefix.every((p, i) => parts[i + 1] === p);
  });
}

/** The canonical string an approval matcher is tested against, per tool. */
export function approvalSubject(tool: string, args: Record<string, unknown>): string {
  if (tool === 'run_command') return String(args.cmd ?? '');
  if (tool === 'write_file') return String(args.path ?? '');
  return JSON.stringify(args);
}

export function approvalRequired(policy: RolePolicy, tool: string, args: Record<string, unknown>): boolean {
  const subject = approvalSubject(tool, args);
  return policy.approvalRequired.some((m) => m.tool === tool && (!m.match || globMatch(m.match, subject)));
}
