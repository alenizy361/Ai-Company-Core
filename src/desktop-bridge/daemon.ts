// Loopback-only HTTP wrapper around dispatchDesktopAction() — the same
// sidecar pattern src/server/routes/health.ts already uses for the
// Chatterbox TTS service. This is the ONLY thing the API server process
// talks to; it never imports dispatch.ts or backend.ts directly, because
// this daemon (not the API server) is the one process with real desktop
// session access.
//
// v1 note: the kill switch (kill-switch.ts) guarantees no NEW action starts
// once engaged, but does not forcibly abort an action already mid-flight —
// that action still completes or times out via desktopActionTimeoutMs
// (bounded, currently 15s by default). Forcibly tracking and SIGKILLing an
// in-flight backend subprocess is real additional complexity deferred past
// v1; the bounded timeout keeps the worst case small in the meantime.
import { createServer } from 'node:http';
import type { Db } from '../shared/db.ts';
import type { SystemConfig, Paths } from '../shared/config.ts';
import { Router, json, errorJson } from '../server/router.ts';
import { dispatchDesktopAction } from './dispatch.ts';
import { loadDesktopPolicy } from './policy.ts';
import { isKilled, kill, resume } from './kill-switch.ts';
import { resolveBackend, type ResolvedBackend } from './backend.ts';
import { dispatchBrowserAction } from './browser/dispatch.ts';
import { loadBrowserPolicy } from './browser/policy.ts';
import { resolveBrowserBackend } from './browser/resolve.ts';
import type { ResolvedBrowserBackend } from './browser/backend.ts';
import { dispatchAtspiAction } from './atspi/dispatch.ts';
import { loadAtspiPolicy } from './atspi/policy.ts';
import { resolveAtspiBackend } from './atspi/resolve.ts';
import type { ResolvedAtspiBackend } from './atspi/backend.ts';
import { getWorkflow } from './workflows/store.ts';
import { replayWorkflow } from './workflows/replay.ts';

export interface DesktopDaemonDeps {
  db: Db;
  cfg: SystemConfig;
  paths: Paths;
  orgId: string;
}

export function startDesktopDaemon(deps: DesktopDaemonDeps): { close: () => void } {
  const token = process.env.DESKTOP_BRIDGE_TOKEN ?? '';
  const authorized = (authHeader: string | undefined): boolean => {
    if (!token) return true; // matches the main API server's OWNER_TOKEN-unset trust model
    return authHeader === `Bearer ${token}`;
  };

  // Re-probed on every call rather than cached once at boot, for all three
  // backends — the owner may install/enable the GNOME extension, install
  // Playwright, or install AT-SPI packages AFTER this daemon started, and
  // /health must reflect reality, not the state from process start.
  const getBackend = async (): Promise<ResolvedBackend> => resolveBackend();
  const getBrowserBackend = async (): Promise<ResolvedBrowserBackend> => resolveBrowserBackend(deps.paths.varDir);
  const getAtspiBackend = async (): Promise<ResolvedAtspiBackend> => resolveAtspiBackend();

  const router = new Router();

  router.get('/health', async ({ res }) => {
    const [backend, browser, atspi] = await Promise.all([getBackend(), getBrowserBackend(), getAtspiBackend()]);
    const policy = loadDesktopPolicy();
    const browserPolicy = loadBrowserPolicy();
    const atspiPolicy = loadAtspiPolicy();
    json(res, 200, {
      ok: backend.ready,
      enabled: policy.enabled,
      armed: !isKilled(deps.paths),
      backend: { kind: backend.kind, ready: backend.ready, reason: backend.reason },
      dependencies: backend.dependencies,
      browser: { enabled: browserPolicy.enabled, kind: browser.kind, ready: browser.ready, reason: browser.reason, dependencies: browser.dependencies },
      atspi: { enabled: atspiPolicy.enabled, kind: atspi.kind, ready: atspi.ready, reason: atspi.reason, dependencies: atspi.dependencies },
    });
  });

  router.post('/actions/:name', async ({ res, params, body }) => {
    const b = body as { args?: Record<string, unknown>; agentKey?: string; conversationId?: string | null } | undefined;
    const policy = loadDesktopPolicy();
    if (!policy.enabled) {
      return errorJson(res, 403, 'DISABLED', 'the desktop bridge is disabled — set "enabled": true in config/desktop-bridge.json');
    }
    const { backend } = await getBackend();
    const result = await dispatchDesktopAction(
      { db: deps.db, cfg: deps.cfg, paths: deps.paths, orgId: deps.orgId, conversationId: b?.conversationId ?? null, agentKey: b?.agentKey ?? 'sira', artifactsDir: deps.paths.artifactsDir },
      policy, backend, params.name, b?.args ?? {},
    );
    json(res, 200, result);
  });

  router.post('/browser/:name', async ({ res, params, body }) => {
    const b = body as { args?: Record<string, unknown>; agentKey?: string; conversationId?: string | null } | undefined;
    const policy = loadBrowserPolicy();
    if (!policy.enabled) {
      return errorJson(res, 403, 'DISABLED', 'the browser bridge is disabled — set "enabled": true in config/browser-bridge.json');
    }
    const { backend } = await getBrowserBackend();
    const result = await dispatchBrowserAction(
      { db: deps.db, cfg: deps.cfg, paths: deps.paths, orgId: deps.orgId, conversationId: b?.conversationId ?? null, agentKey: b?.agentKey ?? 'sira', artifactsDir: deps.paths.artifactsDir },
      policy, backend, params.name, b?.args ?? {},
    );
    json(res, 200, result);
  });

  router.post('/atspi/:name', async ({ res, params, body }) => {
    const b = body as { args?: Record<string, unknown>; agentKey?: string; conversationId?: string | null } | undefined;
    const policy = loadAtspiPolicy();
    if (!policy.enabled) {
      return errorJson(res, 403, 'DISABLED', 'the AT-SPI bridge is disabled — set "enabled": true in config/atspi-bridge.json');
    }
    const { backend } = await getAtspiBackend();
    const result = await dispatchAtspiAction(
      { db: deps.db, cfg: deps.cfg, paths: deps.paths, orgId: deps.orgId, conversationId: b?.conversationId ?? null, agentKey: b?.agentKey ?? 'sira', artifactsDir: deps.paths.artifactsDir },
      policy, backend, params.name, b?.args ?? {},
    );
    json(res, 200, result);
  });

  router.post('/workflows/:name/run', async ({ res, params, body }) => {
    const b = body as { params?: Record<string, string>; agentKey?: string; conversationId?: string | null } | undefined;
    const workflow = getWorkflow(deps.db, deps.orgId, params.name);
    if (!workflow) return errorJson(res, 404, 'NOT_FOUND', `no saved workflow named "${params.name}"`);

    const actionCtx = {
      db: deps.db, cfg: deps.cfg, paths: deps.paths, orgId: deps.orgId,
      conversationId: b?.conversationId ?? null, agentKey: b?.agentKey ?? 'sira', artifactsDir: deps.paths.artifactsDir,
    };
    const result = workflow.kind === 'browser'
      ? await (async () => {
          const policy = loadBrowserPolicy();
          if (!policy.enabled) return { ok: false, error: 'the browser bridge is disabled — set "enabled": true in config/browser-bridge.json', stepsCompleted: 0, totalSteps: 0, results: [] };
          const { backend } = await getBrowserBackend();
          return replayWorkflow(deps.db, workflow, b?.params ?? {}, { browserActionCtx: actionCtx, browserPolicy: policy, browserBackend: backend });
        })()
      : await (async () => {
          const policy = loadAtspiPolicy();
          if (!policy.enabled) return { ok: false, error: 'the AT-SPI bridge is disabled — set "enabled": true in config/atspi-bridge.json', stepsCompleted: 0, totalSteps: 0, results: [] };
          const { backend } = await getAtspiBackend();
          return replayWorkflow(deps.db, workflow, b?.params ?? {}, { atspiActionCtx: actionCtx, atspiPolicy: policy, atspiBackend: backend });
        })();
    json(res, 200, result);
  });

  router.post('/kill', async ({ res, body }) => {
    const reason = String((body as { reason?: string } | undefined)?.reason ?? 'owner-initiated stop');
    kill(deps.db, deps.paths, deps.orgId, reason);
    json(res, 200, { ok: true, armed: false });
  });

  router.post('/resume', async ({ res }) => {
    resume(deps.db, deps.paths, deps.orgId);
    json(res, 200, { ok: true, armed: true });
  });

  const server = createServer(async (req, res) => {
    if (!authorized(req.headers.authorization)) {
      return errorJson(res, 401, 'UNAUTHORIZED', 'missing or invalid desktop-bridge token');
    }
    const handled = await router.dispatch(req, res);
    if (!handled) errorJson(res, 404, 'NOT_FOUND', `no route for ${req.method} ${req.url}`);
  });

  // Loopback-only, always — never deps.cfg.host. This daemon must never be
  // reachable from the network even if the main API server is (Section 11's
  // opt-in-to-expose logic applies to the API server, not this daemon).
  server.listen(deps.cfg.desktopBridgePort, '127.0.0.1');

  return { close: () => server.close() };
}
