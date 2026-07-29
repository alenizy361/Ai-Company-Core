// Adapter selection with honest degradation:
//   ADAPTER env override -> anthropic-api if ANTHROPIC_API_KEY -> claude-cli
//   if the CLI is authenticated -> mock, loudly labeled.
// The selection reason is surfaced on /api/health and in the frontend banner;
// falling back is never silent.
import { spawnSync } from 'node:child_process';
import { MockAdapter } from './mock.ts';
import { ClaudeCliAdapter, probeCliAuth, resolveClaudeBin } from './claude-cli.ts';
import { AnthropicApiAdapter } from './anthropic-api.ts';
import type { ModelAdapter } from './types.ts';

export interface AdapterSelection {
  adapter: ModelAdapter;
  name: string;
  reason: string;
}

// TTL'd, not permanent: a CLI login/install that happens after boot must
// become visible without a process restart (health reads this via
// describeAdapterSelection).
const CLI_PROBE_TTL_MS = 5 * 60_000;
let cliProbeCache: { result: { ok: boolean; detail: string }; at: number } | null = null;

export function cliAvailable(): { ok: boolean; detail: string } {
  if (cliProbeCache && Date.now() - cliProbeCache.at < CLI_PROBE_TTL_MS) return cliProbeCache.result;
  const which = spawnSync(resolveClaudeBin(), ['--version'], { timeout: 10000, encoding: 'utf8' });
  const result = which.error || which.status !== 0
    ? { ok: false, detail: 'claude CLI not found (PATH + standard install locations checked)' }
    : probeCliAuth();
  cliProbeCache = { result, at: Date.now() };
  return result;
}

export function selectAdapter(): AdapterSelection {
  const forced = process.env.ADAPTER;
  if (forced === 'mock') {
    return { adapter: new MockAdapter(), name: 'mock', reason: 'forced via ADAPTER=mock' };
  }
  if (forced === 'api') {
    return { adapter: new AnthropicApiAdapter(), name: 'anthropic-api', reason: 'forced via ADAPTER=api' };
  }
  if (forced === 'cli') {
    return { adapter: new ClaudeCliAdapter(), name: 'claude-cli', reason: 'forced via ADAPTER=cli' };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { adapter: new AnthropicApiAdapter(), name: 'anthropic-api', reason: 'ANTHROPIC_API_KEY configured' };
  }
  const cli = cliAvailable();
  if (cli.ok) {
    return { adapter: new ClaudeCliAdapter(), name: 'claude-cli', reason: 'claude CLI authenticated (subscription login)' };
  }
  return {
    adapter: new MockAdapter(),
    name: 'mock',
    reason: `no real adapter available: ${cli.detail}; set ANTHROPIC_API_KEY or run "claude login"`,
  };
}

/** Cheap description for /api/health without instantiating the worker path. */
export function describeAdapterSelection(): { name: string; reason: string } {
  const sel = selectAdapter();
  return { name: sel.name, reason: sel.reason };
}
