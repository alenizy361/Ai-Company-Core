// Benchmark harness for the browser/AT-SPI automation layers: measures
// call-count deltas between granular multi-call sequences and their
// composite equivalents (browser_fill_form, browser_extract), and between a
// manual multi-call sequence and saved-workflow replay.
//
// IMPORTANT: every number below is measured against FAKE backends
// (SIRA_BROWSER_BACKEND=fake / SIRA_ATSPI_BACKEND=fake) in a throwaway temp
// DB — this is harness/audit overhead, NOT real Playwright/AT-SPI/GNOME
// timing. Real timing depends on page load, network, and UI paint speed the
// fake backends don't model at all. For genuine numbers, re-run this same
// command on the owner's machine with those two env vars unset (after
// `./scripts/install-sira.sh --enable-browser-bridge --enable-atspi-bridge`).
//
// Usage: npm run bench:automation
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../shared/db.ts';
import { loadPaths, loadSystemConfig } from '../shared/config.ts';
import { seedOrgAndAgents } from '../shared/seed.ts';
import { ulid } from '../shared/ids.ts';
import { dispatchBrowserAction, type BrowserActionCtx } from '../desktop-bridge/browser/dispatch.ts';
import { FakeBrowserBackend } from '../desktop-bridge/browser/backends/fake.ts';
import type { BrowserPolicy } from '../desktop-bridge/browser/policy.ts';
import { dispatchAtspiAction, type AtspiActionCtx } from '../desktop-bridge/atspi/dispatch.ts';
import { FakeAtspiBackend } from '../desktop-bridge/atspi/backends/fake.ts';
import type { AtspiPolicy } from '../desktop-bridge/atspi/policy.ts';
import { saveWorkflow, getWorkflow } from '../desktop-bridge/workflows/store.ts';
import { replayWorkflow } from '../desktop-bridge/workflows/replay.ts';

const HARNESS_NOTICE =
  'measured against FAKE backends in a throwaway DB — harness/audit overhead only, ' +
  "NOT real Playwright/AT-SPI/GNOME timing. Re-run with SIRA_BROWSER_BACKEND and " +
  "SIRA_ATSPI_BACKEND unset on the owner's real machine for genuine numbers.";

// Captured BEFORE overriding SIRA_VAR below — the report lands in the real
// var dir so the owner can find it, even though the benchmark itself runs
// against a disposable temp DB.
const reportVarDir = loadPaths().varDir;

const scratchDir = mkdtempSync(join(tmpdir(), 'sira-bench-'));
process.env.SIRA_VAR = scratchDir;
delete process.env.SIRA_DB;
process.env.SIRA_BROWSER_BACKEND = 'fake';
process.env.SIRA_ATSPI_BACKEND = 'fake';

const paths = loadPaths();
const cfg = loadSystemConfig();
const db = openDb(paths.dbPath, paths.migrationsDir);
seedOrgAndAgents(db);

const conversationId = ulid('cnv');
const startedAt = Date.now();
db.run(
  'INSERT INTO conversations (id, org_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  conversationId, cfg.orgId, 'bench-automation', startedAt, startedAt,
);

const browserCtx: BrowserActionCtx = { db, cfg, paths, orgId: cfg.orgId, conversationId, agentKey: 'sira', artifactsDir: paths.artifactsDir };
const atspiCtx: AtspiActionCtx = { db, cfg, paths, orgId: cfg.orgId, conversationId, agentKey: 'sira', artifactsDir: paths.artifactsDir };
const browserPolicy: BrowserPolicy = { enabled: true, deniedUrlPatterns: [] };
const atspiPolicy: AtspiPolicy = { enabled: true };

interface ScenarioResult {
  name: string;
  /** Calls the model itself would have to make (MCP tool_use round trips). */
  modelRoundTrips: number;
  /** Resulting tool_calls audit rows — always 1 per dispatched action. */
  auditRows: number;
  wallClockMs: number;
  ok: boolean;
}

const results: ScenarioResult[] = [];

function auditRowCount(): number {
  return db.get<{ n: number }>('SELECT COUNT(*) as n FROM tool_calls WHERE conversation_id = ?', conversationId)!.n;
}

async function scenario(name: string, modelRoundTrips: number, fn: () => Promise<boolean>): Promise<void> {
  const before = auditRowCount();
  const start = performance.now();
  const ok = await fn();
  const wallClockMs = performance.now() - start;
  const auditRows = auditRowCount() - before;
  results.push({ name, modelRoundTrips, auditRows, wallClockMs, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}  (round_trips=${modelRoundTrips} audit_rows=${auditRows} wall_ms=${wallClockMs.toFixed(2)})`);
}

console.log(`SIRA automation benchmark — fake backends only\n${HARNESS_NOTICE}\n`);

console.log('Browser form fill:');
await scenario('granular — 3x browser_fill', 3, async () => {
  const backend = new FakeBrowserBackend();
  const fields = [
    { selector: '#name', value: 'ada' },
    { selector: '#email', value: 'ada@example.com' },
    { selector: '#company', value: 'sira' },
  ];
  for (const f of fields) {
    const r = await dispatchBrowserAction(browserCtx, browserPolicy, backend, 'fill', f);
    if (!r.ok) return false;
  }
  return true;
});
await scenario('composite — 1x browser_fill_form', 1, async () => {
  const backend = new FakeBrowserBackend();
  const r = await dispatchBrowserAction(browserCtx, browserPolicy, backend, 'fill_form', {
    fields: [
      { selector: '#name', value: 'ada' },
      { selector: '#email', value: 'ada@example.com' },
      { selector: '#company', value: 'sira' },
    ],
  });
  return r.ok;
});

console.log('\nBrowser multi-field read:');
await scenario('granular — 3x browser_get_text', 3, async () => {
  const backend = new FakeBrowserBackend();
  for (const selector of ['#title', '#price', '#stock']) {
    const r = await dispatchBrowserAction(browserCtx, browserPolicy, backend, 'get_text', { selector });
    if (!r.ok) return false;
  }
  return true;
});
await scenario('composite — 1x browser_extract', 1, async () => {
  const backend = new FakeBrowserBackend();
  const r = await dispatchBrowserAction(browserCtx, browserPolicy, backend, 'extract', {
    selectors: { title: '#title', price: '#price', stock: '#stock' },
  });
  return r.ok;
});

console.log('\nAT-SPI baseline (no composite tool exists yet for this layer):');
await scenario('atspi_click — single action', 1, async () => {
  const backend = new FakeAtspiBackend();
  const r = await dispatchAtspiAction(atspiCtx, atspiPolicy, backend, 'click', { name_pattern: 'Open' });
  return r.ok;
});

console.log('\nSaved workflow replay vs. manual equivalent (2-step browser sequence):');
await scenario('manual — 2x separate MCP calls (navigate, click)', 2, async () => {
  const backend = new FakeBrowserBackend();
  const nav = await dispatchBrowserAction(browserCtx, browserPolicy, backend, 'navigate', { url: 'https://example.com' });
  if (!nav.ok) return false;
  const click = await dispatchBrowserAction(browserCtx, browserPolicy, backend, 'click', { selector: '#go' });
  return click.ok;
});
await scenario('workflow_run — 1x MCP call replaying the same 2 steps', 1, async () => {
  const backend = new FakeBrowserBackend();
  saveWorkflow(db, {
    orgId: cfg.orgId, name: 'bench-open-and-click', kind: 'browser', signature: {},
    steps: [
      { tool: 'browser_navigate', args: { url: 'https://example.com' } },
      { tool: 'browser_click', args: { selector: '#go' } },
    ],
  });
  const workflow = getWorkflow(db, cfg.orgId, 'bench-open-and-click')!;
  const result = await replayWorkflow(db, workflow, {}, { browserActionCtx: browserCtx, browserPolicy, browserBackend: backend });
  return result.ok;
});

console.log('\nSummary — round trips saved by composite/workflow tools (call-count only, not real timing):');
const pairs: [string, string][] = [
  ['granular — 3x browser_fill', 'composite — 1x browser_fill_form'],
  ['granular — 3x browser_get_text', 'composite — 1x browser_extract'],
  ['manual — 2x separate MCP calls (navigate, click)', 'workflow_run — 1x MCP call replaying the same 2 steps'],
];
for (const [granularName, compositeName] of pairs) {
  const granular = results.find((r) => r.name === granularName);
  const composite = results.find((r) => r.name === compositeName);
  if (!granular || !composite) continue;
  const saved = granular.modelRoundTrips - composite.modelRoundTrips;
  const pct = Math.round((saved / granular.modelRoundTrips) * 100);
  console.log(`  ${compositeName}: ${saved} fewer model round trip(s) than ${granularName} (${pct}%)`);
}

const failures = results.filter((r) => !r.ok);

const report = { generatedAt: startedAt, notice: HARNESS_NOTICE, results };
const benchDir = join(reportVarDir, 'bench');
mkdirSync(benchDir, { recursive: true });
const reportPath = join(benchDir, `${startedAt}.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\nReport written to ${reportPath}`);

db.close();
rmSync(scratchDir, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
