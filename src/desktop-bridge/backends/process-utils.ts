// Shared shell-free command execution — same discipline as
// src/tools/impl/command.ts's run_command tool (no shell, no
// interpolation, no pipes/redirection), reused by every real
// DesktopBackend's runCommand().
import { spawn } from 'node:child_process';
import type { CommandResult } from '../backend.ts';

const OUTPUT_CAP = 30_000;

export function runShellFreeCommand(cmd: string, timeoutMs: number): Promise<CommandResult> {
  const parts = cmd.trim().split(/\s+/);
  return new Promise((resolvePromise) => {
    const child = spawn(parts[0], parts.slice(1), {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolvePromise({ exitCode: null, stdout: stdout.slice(-OUTPUT_CAP), stderr: `${stderr.slice(-OUTPUT_CAP)}\n[timed out after ${timeoutMs}ms]` });
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode: null, stdout: '', stderr: `failed to spawn: ${err.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode: code, stdout: stdout.slice(-OUTPUT_CAP), stderr: stderr.slice(-OUTPUT_CAP) });
    });
  });
}
