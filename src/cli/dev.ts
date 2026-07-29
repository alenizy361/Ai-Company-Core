// Dev runner: spawns the API server and the worker as separate child processes
// (they are independent in production too — tests kill each separately).
// Restarts a crashed child with backoff; Ctrl-C tears both down.
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from '../shared/config.ts';

interface Managed {
  name: string;
  entry: string;
  child?: ChildProcess;
  restarts: number;
}

const services: Managed[] = [
  { name: 'api', entry: join(REPO_ROOT, 'src', 'server', 'index.ts'), restarts: 0 },
  { name: 'worker', entry: join(REPO_ROOT, 'src', 'worker', 'index.ts'), restarts: 0 },
];

let shuttingDown = false;

function prefix(name: string, data: Buffer, to: NodeJS.WriteStream): void {
  for (const line of data.toString().split('\n')) {
    if (line.trim()) to.write(`[${name}] ${line}\n`);
  }
}

function start(svc: Managed): void {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', svc.entry], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  svc.child = child;
  child.stdout?.on('data', (d: Buffer) => prefix(svc.name, d, process.stdout));
  child.stderr?.on('data', (d: Buffer) => prefix(svc.name, d, process.stderr));
  child.on('exit', (code) => {
    if (shuttingDown) return;
    svc.restarts++;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(svc.restarts, 5));
    process.stderr.write(`[dev] ${svc.name} exited (code ${code}); restarting in ${delay}ms\n`);
    setTimeout(() => start(svc), delay);
  });
}

for (const svc of services) start(svc);

function shutdown(): void {
  shuttingDown = true;
  for (const svc of services) svc.child?.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
