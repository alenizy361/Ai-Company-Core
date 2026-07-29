// run_command: allowlisted binary + argument prefix, spawned WITHOUT a shell
// (no interpolation, no pipes, no redirection), cwd = the objective workspace.
import { spawn } from 'node:child_process';
import type { Tool, ToolResult } from '../types.ts';

const OUTPUT_CAP = 30_000;

export const runCommandTool: Tool = {
  name: 'run_command',
  description:
    'Run an allowlisted command in the workspace (no shell: no pipes/redirection/substitution). Args: {cmd, timeout_ms?}. Returns exit code, stdout, stderr.',
  effects: 'execute',
  schema: {
    type: 'object',
    properties: {
      cmd: { type: 'string', minLength: 1 },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000 },
    },
    required: ['cmd'],
    additionalProperties: true,
  },
  run(args, ctx): Promise<ToolResult> {
    const parts = String(args.cmd).trim().split(/\s+/);
    const timeout = Math.min(Number(args.timeout_ms ?? ctx.cfg.toolTimeoutMs), ctx.cfg.toolTimeoutMs);
    return new Promise((resolvePromise) => {
      const child = spawn(parts[0], parts.slice(1), {
        cwd: ctx.workspaceRoot,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '', HOME: ctx.workspaceRoot, NODE_ENV: 'development' },
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        resolvePromise({ ok: false, error: `command timed out after ${timeout}ms`, data: { stdout: stdout.slice(-OUTPUT_CAP), stderr: stderr.slice(-OUTPUT_CAP) } });
      }, timeout);
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ ok: false, error: `failed to spawn: ${err.message}` });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({
          ok: code === 0,
          data: {
            cmd: args.cmd,
            exit_code: code,
            stdout: stdout.slice(-OUTPUT_CAP),
            stderr: stderr.slice(-OUTPUT_CAP),
            stdout_truncated: stdout.length > OUTPUT_CAP,
            stderr_truncated: stderr.length > OUTPUT_CAP,
          },
          error: code === 0 ? undefined : `exit code ${code}`,
        });
      });
    });
  },
};
