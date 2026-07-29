// Spawns the real SIRA API server (and optionally a worker) as child
// processes against a throwaway database — the vt-server pattern, reused by
// the UI acceptance suite.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface UiServer {
  base: string;
  dir: string;
  serverProc: ChildProcess;
  workerProc: ChildProcess | null;
  startWorker: (extraEnv?: Record<string, string>) => ChildProcess;
  stop: () => void;
}

export async function startUiServer(port = 4890, extraEnv: Record<string, string> = {}): Promise<UiServer> {
  const dir = mkdtempSync(join(tmpdir(), 'sira-ui-srv-'));
  const env = {
    ...process.env,
    SIRA_VAR: dir,
    PORT: String(port),
    ADAPTER: 'mock',
    ...extraEnv,
  };
  delete (env as Record<string, unknown>).SIRA_DB;
  const serverProc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server/index.ts'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://localhost:${port}`;

  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    try {
      ok = (await fetch(`${base}/api/health`)).ok;
    } catch { /* not up yet */ }
    if (!ok) await new Promise((r) => setTimeout(r, 250));
  }
  if (!ok) throw new Error('ui server failed to start');

  let workerProc: ChildProcess | null = null;
  const startWorker = (weEnv: Record<string, string> = {}): ChildProcess => {
    workerProc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/worker/index.ts'], {
      env: { ...env, ...weEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return workerProc;
  };

  return {
    base, dir, serverProc, workerProc, startWorker,
    stop() {
      serverProc.kill('SIGTERM');
      workerProc?.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
