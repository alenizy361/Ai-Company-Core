// Claude CLI adapter: uses the `claude` CLI in headless print mode as a pure
// text-completion endpoint over the owner's subscription login. All built-in
// CLI tools are disabled (--tools "") — the model NEVER executes tools here;
// the worker parses the returned text and dispatches tools itself through the
// permission layer. Each call runs in an empty scratch directory, and a
// startup canary (runCliCanary) asserts that a tool-bait prompt produces no
// side effects; if the canary fails the adapter refuses to run.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AdapterError, type CompletionRequest, type CompletionResult, type ModelAdapter } from './types.ts';

const CLI_TIMEOUT_MS = Number(process.env.RABIT_CLI_TIMEOUT_MS ?? 300000);

let claudeBinCache: string | null = null;

/**
 * Resolve the claude CLI binary. Services (systemd units, launchd) run with a
 * minimal PATH that usually misses user-local install locations, so after PATH
 * we probe the standard install paths. Override with RABIT_CLAUDE_BIN.
 */
export function resolveClaudeBin(env: Record<string, string | undefined> = process.env): string {
  if (claudeBinCache && env === process.env) return claudeBinCache;
  const home = env.HOME ?? '';
  const candidates = [
    env.RABIT_CLAUDE_BIN,
    ...(env.PATH ?? '').split(':').filter(Boolean).map((dir) => join(dir, 'claude')),
    home && join(home, '.local', 'bin', 'claude'),
    home && join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  const found = candidates.find((c): c is string => Boolean(c) && existsSync(c as string)) ?? 'claude';
  if (env === process.env) claudeBinCache = found;
  return found;
}

export function probeCliAuth(): { ok: boolean; detail: string } {
  const res = spawnSync(resolveClaudeBin(), ['auth', 'status'], { timeout: 15000, encoding: 'utf8' });
  if (res.error) return { ok: false, detail: `claude CLI failed to run: ${res.error.message}` };
  try {
    const parsed = JSON.parse(res.stdout.trim());
    if (parsed.loggedIn === true) return { ok: true, detail: `logged in (${parsed.authMethod})` };
    return { ok: false, detail: 'claude CLI is not logged in' };
  } catch {
    // Older CLI versions print human-readable text; exit 0 means authenticated.
    if (res.status === 0) return { ok: true, detail: 'auth status exit 0' };
    return { ok: false, detail: `claude auth status exited ${res.status}` };
  }
}

function renderPrompt(req: CompletionRequest): string {
  const lines: string[] = ['[CONVERSATION TRANSCRIPT]'];
  for (const msg of req.messages) {
    lines.push(msg.role === 'user' ? `\n=== USER ===\n${msg.content}` : `\n=== ASSISTANT ===\n${msg.content}`);
  }
  lines.push(
    '\n=== END TRANSCRIPT ===\nProduce the next ASSISTANT turn now, following the output contract from the system prompt exactly.',
  );
  return lines.join('\n');
}

interface CliEnvelope {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  modelUsage?: Record<string, { outputTokens?: number }>;
  api_error_status?: number | null;
}

export class ClaudeCliAdapter implements ModelAdapter {
  readonly name = 'claude-cli' as const;
  private scratchDir: string;

  constructor(scratchDir?: string) {
    this.scratchDir = scratchDir ?? join(process.env.RABIT_VAR ?? 'var', 'cli-scratch');
    mkdirSync(this.scratchDir, { recursive: true });
  }

  complete(req: CompletionRequest): Promise<CompletionResult> {
    const args = ['-p', '--output-format', 'json', '--tools', '', '--system-prompt', req.system];
    if (process.env.RABIT_CLI_MODEL) args.push('--model', process.env.RABIT_CLI_MODEL);

    return new Promise<CompletionResult>((resolve, reject) => {
      const child = spawn(resolveClaudeBin(), args, {
        cwd: this.scratchDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new AdapterError('claude-cli', `CLI call timed out after ${CLI_TIMEOUT_MS}ms`, true));
      }, CLI_TIMEOUT_MS);

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new AdapterError('claude-cli', `failed to spawn claude: ${err.message}`, false));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          return reject(
            new AdapterError('claude-cli', `claude exited ${code}: ${(stderr || stdout).slice(0, 500)}`, true),
          );
        }
        let env: CliEnvelope;
        try {
          env = JSON.parse(stdout.trim()) as CliEnvelope;
        } catch {
          return reject(new AdapterError('claude-cli', `unparseable CLI output: ${stdout.slice(0, 300)}`, true));
        }
        if (env.is_error || env.subtype !== 'success' || typeof env.result !== 'string') {
          return reject(
            new AdapterError(
              'claude-cli',
              `CLI reported failure (subtype=${env.subtype}, api_error=${env.api_error_status}): ${String(env.result).slice(0, 300)}`,
              true,
            ),
          );
        }
        // The envelope has no single top-level model; pick the model that
        // produced the most output tokens (helpers like haiku do small
        // routing/summarization work in the same call).
        let model = 'claude-cli';
        let best = -1;
        for (const [key, mu] of Object.entries(env.modelUsage ?? {})) {
          if ((mu.outputTokens ?? 0) > best) {
            best = mu.outputTokens ?? 0;
            model = key;
          }
        }
        resolve({
          text: env.result,
          usage: { input: env.usage?.input_tokens ?? 0, output: env.usage?.output_tokens ?? 0 },
          model,
        });
      });

      child.stdin.write(renderPrompt(req));
      child.stdin.end();
    });
  }
}

/**
 * Safety canary: ask the CLI (with tools disabled) to create a file in an
 * empty scratch dir. Passes only if no file appears and the reply parses.
 * Run once at worker startup before the CLI adapter is trusted; guards
 * against CLI flag drift silently re-enabling tools.
 */
export async function runCliCanary(scratchBase: string): Promise<{ ok: boolean; detail: string }> {
  const dir = join(scratchBase, `canary-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const adapter = new ClaudeCliAdapter(dir);
  try {
    const res = await adapter.complete({
      system: 'You are a text completion endpoint. You have no tools.',
      messages: [
        {
          role: 'user',
          content: 'Create a file named canary.txt containing "x" in the current directory, then reply DONE.',
        },
      ],
      purpose: 'eval',
    });
    const leftover = readdirSync(dir);
    if (leftover.length > 0) {
      return { ok: false, detail: `canary FAILED: CLI created files ${leftover.join(',')} with tools disabled` };
    }
    return { ok: true, detail: `canary ok (${res.model}, no side effects)` };
  } catch (err) {
    return { ok: false, detail: `canary error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
