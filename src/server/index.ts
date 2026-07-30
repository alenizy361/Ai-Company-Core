// SIRA OS API server. Serves the web client, the JSON API, and the SSE
// event stream. Never executes agent work — that is the worker's job.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../shared/db.ts';
import { loadPaths, loadSystemConfig } from '../shared/config.ts';
import { seedOrgAndAgents } from '../shared/seed.ts';
import { Router, errorJson } from './router.ts';
import { SseHub } from './sse.ts';
import { serveStatic } from './static.ts';
import { registerStateRoutes } from './routes/state.ts';
import { registerReadRoutes } from './routes/reads.ts';
import { registerWriteRoutes } from './routes/writes.ts';
import { registerConverseRoutes } from './routes/converse.ts';
import { registerVoiceRoutes } from './routes/voice.ts';
import { registerEvalRoutes } from './routes/evals.ts';
import { registerVoiceProviderRoutes } from './routes/voice-providers.ts';
import { registerSearchRoutes } from './routes/search.ts';
import { registerHealthRoute, type AdapterInfo } from './routes/health.ts';
import { describeAdapterSelection, selectAdapter } from '../adapters/select.ts';
import type { ModelAdapter } from '../adapters/types.ts';
import { activateBaselineAgentPrompts, seedPromptsFromDisk } from '../promptreg/registry.ts';
import type { SiraManager } from '../sira/session.ts';
import { runObjectiveCompletionSweep } from '../sira/objective-bridge.ts';

const paths = loadPaths();
const cfg = loadSystemConfig();
const db = openDb(paths.dbPath, paths.migrationsDir);
seedOrgAndAgents(db);
seedPromptsFromDisk(db, paths.promptsDir);
activateBaselineAgentPrompts(db, cfg.orgId);

const hub = new SseHub(db, cfg.ssePollMs);
const router = new Router();

// TTL'd so a claude login / key change after boot surfaces on /api/health
// without restarting the server (the worker's recorded adapter still wins
// when a live worker exists — see routes/health.ts).
let adapterInfoCache: { info: AdapterInfo; at: number } | null = null;
function getAdapterInfo(): AdapterInfo {
  if (!adapterInfoCache || Date.now() - adapterInfoCache.at > 60_000) {
    adapterInfoCache = { info: describeAdapterSelection(), at: Date.now() };
  }
  return adapterInfoCache.info;
}

let converseAdapter: ModelAdapter | null = null;
function getConverseAdapter(): ModelAdapter {
  // Converse is conversational I/O (no tool execution) — the one model-call
  // path that lives in the API process, for latency.
  if (!converseAdapter) converseAdapter = selectAdapter().adapter;
  return converseAdapter;
}

// The Agent SDK engine: one persistent parent SIRA session per conversation.
// Loaded DYNAMICALLY so a missing/broken SDK package (e.g. `git pull` without
// `npm install`) degrades to the legacy engine with a loud log — it must
// never kill the whole server (that reads as "SIRA is deaf and mute").
let sira: SiraManager | null = null;
let engineReason: string;
try {
  const mod = await import('../sira/session.ts');
  sira = mod.createSiraManager(db, cfg, paths);
  engineReason = sira ? 'real Claude auth available' : 'no real Claude auth (or ADAPTER=mock / SIRA_ENGINE=legacy)';
} catch (err) {
  engineReason = `agent-sdk package failed to load: ${err instanceof Error ? err.message : String(err)} — run npm install`;
  console.error(`[sira] ${engineReason}`);
}
const engineInfo = { name: sira ? 'agent-sdk' : 'legacy', reason: engineReason };
console.log(`[sira] conversation engine: ${engineInfo.name} (${engineInfo.reason})`);

// Interface build id: content fingerprint of web/. The client compares it on
// every health refresh and reloads itself once when a new build is deployed —
// the owner must never have to know about hard refreshes.
function computeWebBuildId(dir: string): string {
  const hash = createHash('sha256');
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else hash.update(`${p}:${st.size}:${st.mtimeMs}|`);
    }
  };
  try { walk(dir); } catch { /* partial fingerprint is still a fingerprint */ }
  return hash.digest('hex').slice(0, 16);
}
const webBuildId = computeWebBuildId(paths.webDir);

registerHealthRoute(router, db, hub, cfg, getAdapterInfo, () => engineInfo, () => webBuildId);
registerStateRoutes(router, db, hub, cfg);
registerReadRoutes(router, db);
registerWriteRoutes(router, db);
registerConverseRoutes(router, db, getConverseAdapter, sira);
registerVoiceRoutes(router, db);
registerEvalRoutes(router, db);
registerVoiceProviderRoutes(router, db);
registerSearchRoutes(router, db);

// Background Objective Completion Bridge: SiraSession instances live only in
// THIS process's memory, so the sweep that resumes them for a finished
// background objective must run here too — the worker process only flips
// objectives.completion_summary_status to 'pending' (src/worker/handoff.ts).
let completionSweepRunning = false;
async function tickCompletionSweep(): Promise<void> {
  if (!sira || completionSweepRunning) return;
  completionSweepRunning = true;
  try {
    await runObjectiveCompletionSweep(db, cfg, sira);
  } catch (err) {
    console.error('[sira] objective completion sweep failed:', err instanceof Error ? err.message : err);
  } finally {
    completionSweepRunning = false;
  }
}
const completionSweepInterval = setInterval(() => void tickCompletionSweep(), 5000);
void tickCompletionSweep();

const ownerToken = process.env.OWNER_TOKEN ?? '';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function authorized(req: import('node:http').IncomingMessage): boolean {
  if (!ownerToken) return true; // local single-owner deployment
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${ownerToken}`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    if (url.pathname !== '/api/health' && !authorized(req)) {
      return errorJson(res, 401, 'UNAUTHORIZED', 'missing or invalid owner token');
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      return hub.handle(req, res);
    }
    const handled = await router.dispatch(req, res);
    if (!handled) errorJson(res, 404, 'NOT_FOUND', `no route for ${req.method} ${url.pathname}`);
    return;
  }

  serveStatic(paths.webDir, req, res);
});

// Security boundary (Phase 2): loopback-only by default — an unauthenticated
// API (the default when OWNER_TOKEN is unset) must never be reachable from
// the network unless the owner explicitly opts in via SIRA_HOST. Node's
// server.listen(port) with no host binds every interface (0.0.0.0/::); that
// silent default was the actual vulnerability, not the auth check itself.
if (!LOOPBACK_HOSTS.has(cfg.host) && !ownerToken) {
  console.warn(
    `[sira] WARNING: binding to ${cfg.host} (not loopback) with OWNER_TOKEN unset — ` +
    `the entire API is reachable on your network with NO authentication. ` +
    `Set OWNER_TOKEN in your environment before exposing SIRA beyond localhost.`,
  );
}
server.listen(cfg.port, cfg.host, () => {
  console.log(`[sira] api listening on http://${cfg.host}:${cfg.port} (db: ${paths.dbPath})`);
});

function shutdown(): void {
  clearInterval(completionSweepInterval);
  hub.stop();
  sira?.closeAll();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
