// Node-side process manager for helper.py — a persistent Python worker kept
// alive across calls (spawning it fresh per action would mean paying
// gi/Atspi's import cost every time, which is the whole reason this is a
// long-lived process rather than a one-shot spawnSync like the desktop and
// browser bridges' dependency probes use). NDJSON-over-stdio, matching
// helper.py's protocol exactly: one JSON object per line each direction.
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DEFAULT_HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'helper.py');

export interface AtspiHostDeps {
  pythonBin?: string;
  /** Overridable so tests can point at a fixture stub instead of the real
   *  helper.py — see tests/unit/atspi-host.test.ts. */
  helperPath?: string;
}

export interface AtspiHostResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

interface HelperResponse {
  id: string | null;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class AtspiHost {
  private proc: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private buffer = '';
  private nextId = 0;
  private readonly deps: AtspiHostDeps;

  constructor(deps: AtspiHostDeps = {}) {
    this.deps = deps;
  }

  private ensureStarted(): void {
    if (this.proc) return;

    const pythonBin = this.deps.pythonBin ?? 'python3';
    const helperPath = this.deps.helperPath ?? DEFAULT_HELPER_PATH;
    // shell: false always — the only data crossing the process boundary is
    // the JSON-over-stdin protocol below, never a shell command line.
    const proc = spawn(pythonBin, [helperPath], { shell: false });
    this.proc = proc;

    proc.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: HelperResponse;
        try {
          parsed = JSON.parse(line) as HelperResponse;
        } catch {
          continue; // a malformed line from the helper can't be keyed to any pending request
        }
        if (parsed.id === null || parsed.id === undefined) continue;
        const pendingRequest = this.pending.get(parsed.id);
        if (!pendingRequest) continue; // no matching request (e.g. it already timed out) — drop it
        this.pending.delete(parsed.id);
        pendingRequest.resolve({ ok: parsed.ok, data: parsed.data, error: parsed.error });
      }
    });

    // A ChildProcess with no 'error' listener throws an uncaught exception
    // on spawn failure (e.g. python3 missing) — this must always be wired.
    proc.on('error', (err) => {
      if (this.proc !== proc) return; // stale event from an already-superseded process
      const wrapped = new Error(`AT-SPI helper process failed to start: ${err.message}`);
      for (const pendingRequest of this.pending.values()) pendingRequest.reject(wrapped);
      this.pending.clear();
      this.proc = null;
    });

    proc.on('exit', () => {
      if (this.proc !== proc) return; // stale event from an already-superseded process (e.g. after close())
      const err = new Error('AT-SPI helper process exited');
      for (const pendingRequest of this.pending.values()) pendingRequest.reject(err);
      this.pending.clear();
      this.proc = null; // clears so the NEXT call() lazily respawns
    });
  }

  async call(action: string, args: Record<string, unknown>, timeoutMs = 8000): Promise<AtspiHostResult> {
    this.ensureStarted();
    const proc = this.proc;
    if (!proc || !proc.stdin) {
      throw new Error('AT-SPI helper process is not running');
    }

    const id = `req-${this.nextId++}`;
    const resultPromise = new Promise<AtspiHostResult>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as AtspiHostResult), reject });
    });

    proc.stdin.write(`${JSON.stringify({ id, action, args })}\n`);

    // A timed-out/rejected request does NOT kill the process — AT-SPI
    // itself may legitimately be slow, not dead. Only that one request
    // fails; the process stays up for the next call.
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`AT-SPI request timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timer.unref();
    });

    return Promise.race([resultPromise, timeoutPromise]);
  }

  close(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    const err = new Error('AT-SPI host closed');
    for (const pendingRequest of this.pending.values()) pendingRequest.reject(err);
    this.pending.clear();
  }
}
