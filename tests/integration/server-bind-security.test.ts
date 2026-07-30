// Security boundary: the API server must REFUSE to start (not merely warn)
// when configured to bind beyond loopback with no OWNER_TOKEN set — an
// unauthenticated API silently reachable on the network is exactly the
// vulnerability this refusal exists to prevent. Spawns the real server
// entrypoint as a child process (same pattern as tests/ui/server.ts) against
// a throwaway database.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function spawnServer(port: number, extraEnv: Record<string, string>): { proc: ReturnType<typeof spawn>; dir: string; stderr: () => string } {
  const dir = mkdtempSync(join(tmpdir(), 'sira-bind-sec-'));
  const env = { ...process.env, SIRA_VAR: dir, PORT: String(port), ADAPTER: 'mock', ...extraEnv };
  delete (env as Record<string, unknown>).SIRA_DB;
  let stderr = '';
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server/index.ts'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  return { proc, dir, stderr: () => stderr };
}

test('server refuses to start: non-loopback SIRA_HOST with no OWNER_TOKEN exits non-zero and never binds', async (t) => {
  const port = 4897;
  const { proc, dir, stderr } = spawnServer(port, { SIRA_HOST: '0.0.0.0' });
  t.after(() => { proc.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });

  const exitCode = await new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
  assert.notEqual(exitCode, 0, 'the process must exit non-zero rather than silently start unauthenticated');
  assert.match(stderr(), /REFUSING TO START/, 'the reason must be logged, not silent');

  await assert.rejects(
    () => fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) }),
    'the port must never actually accept connections',
  );
});

test('server starts normally: non-loopback SIRA_HOST WITH an OWNER_TOKEN set is allowed', async (t) => {
  const port = 4898;
  const { proc, dir } = spawnServer(port, { SIRA_HOST: '0.0.0.0', OWNER_TOKEN: 'test-secret-token' });
  t.after(() => { proc.kill('SIGTERM'); rmSync(dir, { recursive: true, force: true }); });

  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      ok = res.ok;
    } catch { /* not up yet */ }
    if (!ok) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(ok, 'an explicitly authenticated non-loopback bind is allowed to start');
});

test('server starts normally: loopback host (the default) never requires OWNER_TOKEN', async (t) => {
  const port = 4899;
  const { proc, dir } = spawnServer(port, {});
  t.after(() => { proc.kill('SIGTERM'); rmSync(dir, { recursive: true, force: true }); });

  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      ok = res.ok;
    } catch { /* not up yet */ }
    if (!ok) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(ok, 'the default loopback bind starts fine with no token — local single-owner use case');
});
