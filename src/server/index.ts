// RABIT OS API server. Serves the web client, the JSON API, and the SSE
// event stream. Never executes agent work — that is the worker's job.
import { createServer } from 'node:http';
import { openDb } from '../shared/db.ts';
import { loadPaths, loadSystemConfig } from '../shared/config.ts';
import { seedOrgAndAgents } from '../shared/seed.ts';
import { Router, errorJson } from './router.ts';
import { SseHub } from './sse.ts';
import { serveStatic } from './static.ts';
import { registerStateRoutes } from './routes/state.ts';
import { registerReadRoutes } from './routes/reads.ts';
import { registerHealthRoute, type AdapterInfo } from './routes/health.ts';
import { describeAdapterSelection } from '../adapters/select.ts';

const paths = loadPaths();
const cfg = loadSystemConfig();
const db = openDb(paths.dbPath, paths.migrationsDir);
seedOrgAndAgents(db);

const hub = new SseHub(db, cfg.ssePollMs);
const router = new Router();

let adapterInfoCache: AdapterInfo | null = null;
function getAdapterInfo(): AdapterInfo {
  if (!adapterInfoCache) adapterInfoCache = describeAdapterSelection();
  return adapterInfoCache;
}

registerHealthRoute(router, db, hub, cfg, getAdapterInfo);
registerStateRoutes(router, db, hub, cfg);
registerReadRoutes(router, db);

const ownerToken = process.env.OWNER_TOKEN ?? '';

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

server.listen(cfg.port, () => {
  console.log(`[rabit] api listening on http://localhost:${cfg.port} (db: ${paths.dbPath})`);
});

function shutdown(): void {
  hub.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
