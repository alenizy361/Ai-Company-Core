// Minimal Chrome DevTools Protocol client — zero dependencies (Node 22 has a
// global WebSocket). Used by the UI acceptance suite against the preinstalled
// headless Chromium; skips honestly when no browser binary exists.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.SIRA_CHROME_BIN,
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];

export function findChrome(): string | null {
  for (const c of CANDIDATES) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

interface Target { webSocketDebuggerUrl: string }

export class Browser {
  private proc: ChildProcess;
  private profileDir: string;
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private sessionId = '';
  private eventHandlers = new Map<string, (params: Record<string, unknown>) => void>();

  static async launch(): Promise<Browser> {
    const bin = findChrome();
    if (!bin) throw new Error('no chromium binary found (set SIRA_CHROME_BIN)');
    const b = new Browser(bin);
    await b.connect();
    return b;
  }

  private constructor(bin: string) {
    this.profileDir = mkdtempSync(join(tmpdir(), 'sira-ui-'));
    this.proc = spawn(bin, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      `--user-data-dir=${this.profileDir}`, '--remote-debugging-port=0',
      '--no-first-run', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  private async connect(): Promise<void> {
    // The DevTools ws URL is printed on stderr.
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`devtools url not found in: ${buf.slice(0, 500)}`)), 20000);
      this.proc.stderr!.on('data', (d: Buffer) => {
        buf += d.toString();
        const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buf);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      this.proc.on('error', reject);
    });

    // Discover the page target through the browser endpoint.
    const port = new URL(wsUrl).port;
    let target: Target | undefined;
    for (let i = 0; i < 40 && !target; i++) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as (Target & { type: string })[];
        target = list.find((t) => t.type === 'page');
      } catch { /* devtools http not ready */ }
      if (!target) await new Promise((r) => setTimeout(r, 250));
    }
    if (!target) throw new Error('no page target');

    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('ws connect failed'));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>;
      };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      } else if (msg.method) {
        this.eventHandlers.get(msg.method)?.(msg.params ?? {});
      }
    };
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }

  on(method: string, handler: (params: Record<string, unknown>) => void): void {
    this.eventHandlers.set(method, handler);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
      }, 30000).unref?.();
    });
  }

  async navigate(url: string): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      this.on('Page.loadEventFired', () => resolve());
    });
    await this.send('Page.navigate', { url });
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 10000))]);
  }

  /** Evaluate an expression; resolves the JSON value (awaits promises). */
  async eval<T = unknown>(expression: string): Promise<T> {
    const res = (await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    })) as { result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
    if (res.exceptionDetails) {
      throw new Error(`page error: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result.value;
  }

  /** Poll an expression until truthy (or time out). */
  async waitFor(expression: string, timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (await this.eval<boolean>(`Boolean(${expression})`)) return;
      if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${expression}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: width < 600,
    });
  }

  async screenshot(): Promise<Buffer> {
    const res = (await this.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
    return Buffer.from(res.data, 'base64');
  }

  async clearStorage(origin: string): Promise<void> {
    await this.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
  }

  async close(): Promise<void> {
    try { this.ws.close(); } catch { /* already closed */ }
    this.proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    rmSync(this.profileDir, { recursive: true, force: true });
  }
}
