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

let cliProbeCache: { ok: boolean; detail: string } | null = null;

export function cliAvailable(): { ok: boolean; detail: string } {
  if (cliProbeCache) return cliProbeCache;
  const which = spawnSync(resolveClaudeBin(), ['--version'], { timeout: 10000, encoding: 'utf8' });
  if (which.error || which.status !== 0) {
    cliProbeCache = { ok: false, detail: 'claude CLI not found (PATH + standard install locations checked)' };
    return cliProbeCache;
  }
  cliProbeCache = probeCliAuth();
  return cliProbeCache;
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
