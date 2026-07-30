// SIRA desktop control bridge — a separate OS process/systemd service
// (sira-desktop-bridge) from sira-api and sira-worker, because this is the
// one process that actually needs the desktop session (D-Bus session bus /
// DISPLAY) — isolating that need here keeps the other two processes'
// blast radius unchanged, the same reasoning that already separates the
// worker's execution from the API server's routing.
import { openDb } from '../shared/db.ts';
import { loadPaths, loadSystemConfig } from '../shared/config.ts';
import { seedOrgAndAgents } from '../shared/seed.ts';
import { seedPromptsFromDisk, activateBaselineAgentPrompts } from '../promptreg/registry.ts';
import { startDesktopDaemon } from './daemon.ts';
import { loadDesktopPolicy } from './policy.ts';
import { resolveBackend } from './backend.ts';

const paths = loadPaths();
const cfg = loadSystemConfig();
const db = openDb(paths.dbPath, paths.migrationsDir);
seedOrgAndAgents(db);
seedPromptsFromDisk(db, paths.promptsDir);
activateBaselineAgentPrompts(db, cfg.orgId);

const policy = loadDesktopPolicy();
if (!policy.enabled) {
  console.log('[sira-desktop-bridge] disabled (config/desktop-bridge.json "enabled": false) — daemon still starts so /health is honest, but every action will be refused');
}

const probe = await resolveBackend();
if (!probe.ready) {
  console.warn(`[sira-desktop-bridge] backend "${probe.kind}" not ready: ${probe.reason}`);
} else {
  console.log(`[sira-desktop-bridge] backend "${probe.kind}" ready`);
}

const daemon = startDesktopDaemon({ db, cfg, paths, orgId: cfg.orgId });
console.log(`[sira-desktop-bridge] listening on http://127.0.0.1:${cfg.desktopBridgePort}`);

function shutdown(): void {
  daemon.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
