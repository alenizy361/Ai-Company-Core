// Central config + path resolution. Everything test-relevant is overridable
// via environment variables so integration tests can point at temp dirs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

export interface SystemConfig {
  port: number;
  /** Security boundary (Phase 2): the interface the API server binds to.
   *  Defaults to loopback-only — an unauthenticated API (the default when
   *  OWNER_TOKEN is unset, for a single-owner local deployment) must never
   *  be reachable from the network unless the owner explicitly opts in via
   *  SIRA_HOST. This matches what scripts/install-sira.sh's env template
   *  already documented ("OWNER_TOKEN required only when exposing beyond
   *  localhost") but the server never actually enforced. */
  host: string;
  orgId: string;
  leaseMs: number;
  heartbeatMs: number;
  sweepMs: number;
  ssePollMs: number;
  maxTurnsPerExecution: number;
  maxWallClockMs: number;
  maxConcurrentBranches: number;
  maxAttempts: number;
  approvalTimeoutMs: number;
  staleWorkerMs: number;
  maxReplans: number;
  maxPlanSteps: number;
  toolTimeoutMs: number;
  toolResultInlineLimit: number;
  modelTiers: Record<string, string>;
  converseTier: string;
}

export interface Paths {
  root: string;
  varDir: string;
  dbPath: string;
  artifactsDir: string;
  workspaceDir: string;
  promptsDir: string;
  migrationsDir: string;
  evalsDir: string;
  configDir: string;
  webDir: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function loadSystemConfig(): SystemConfig {
  const cfg = readJson<SystemConfig>(join(REPO_ROOT, 'config', 'system.json'));
  cfg.host = process.env.SIRA_HOST || cfg.host || '127.0.0.1';
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  // Timing overrides so integration tests can exercise lease/sweep/recovery
  // behavior in seconds instead of minutes.
  for (const [env, key] of [
    ['SIRA_LEASE_MS', 'leaseMs'],
    ['SIRA_HEARTBEAT_MS', 'heartbeatMs'],
    ['SIRA_SWEEP_MS', 'sweepMs'],
    ['SIRA_STALE_WORKER_MS', 'staleWorkerMs'],
    ['SIRA_APPROVAL_TIMEOUT_MS', 'approvalTimeoutMs'],
    ['SIRA_MAX_WALL_CLOCK_MS', 'maxWallClockMs'],
  ] as const) {
    if (process.env[env]) (cfg as unknown as Record<string, number>)[key] = Number(process.env[env]);
  }
  return cfg;
}

export function loadPaths(): Paths {
  const varDir = process.env.SIRA_VAR ? resolve(process.env.SIRA_VAR) : join(REPO_ROOT, 'var');
  return {
    root: REPO_ROOT,
    varDir,
    dbPath: process.env.SIRA_DB ?? join(varDir, 'data.db'),
    artifactsDir: join(varDir, 'artifacts'),
    workspaceDir: join(varDir, 'workspace'),
    promptsDir: join(REPO_ROOT, 'prompts'),
    migrationsDir: join(REPO_ROOT, 'src', 'shared', 'migrations'),
    evalsDir: join(REPO_ROOT, 'evals'),
    configDir: join(REPO_ROOT, 'config'),
    webDir: join(REPO_ROOT, 'web'),
  };
}

export interface AgentConfigEntry {
  key: string;
  short: string;
  nameEn: string;
  nameAr: string;
  color: string;
  reportsTo: string | null;
  board: { x: number; y: number };
  /** Default model tier (lowest-cost capable); the owner's override wins. */
  tier: 'fast' | 'balanced' | 'reasoning' | 'custom';
}

export function loadAgentsConfig(): AgentConfigEntry[] {
  return readJson<{ agents: AgentConfigEntry[] }>(join(REPO_ROOT, 'config', 'agents.json')).agents;
}

export interface RolePolicy {
  tools: string[];
  paths: { read: string[]; write: string[] };
  commands: { bin: string; argsPrefix?: string[] }[];
  approvalRequired: { tool: string; match?: string }[];
}

/**
 * Self-development mode: the owner has dedicated this machine to SIRA and
 * explicitly allows it to modify its own interface and code. Off by default;
 * enabled with SIRA_SELF_DEV=1 (e.g. in ~/.config/sira/env).
 */
export function selfDevEnabled(): boolean {
  return process.env.SIRA_SELF_DEV === '1';
}

/** In self-dev mode the objective workspace IS the repository (test-overridable). */
export function selfDevRoot(): string {
  return process.env.SIRA_SELF_DEV_ROOT ?? REPO_ROOT;
}

export function loadPermissions(): Record<string, RolePolicy> {
  const roles = readJson<{ roles: Record<string, RolePolicy> }>(join(REPO_ROOT, 'config', 'permissions.json')).roles;
  if (!selfDevEnabled()) return roles;
  const extra = readJson<{ roles: Record<string, RolePolicy> }>(join(REPO_ROOT, 'config', 'permissions.selfdev.json')).roles;
  for (const [key, grant] of Object.entries(extra)) {
    const base = roles[key];
    if (!base) continue;
    base.tools = [...new Set([...base.tools, ...grant.tools])];
    base.paths.read = [...new Set([...base.paths.read, ...grant.paths.read])];
    base.paths.write = [...new Set([...base.paths.write, ...grant.paths.write])];
    base.commands = [...base.commands, ...grant.commands];
    base.approvalRequired = [...base.approvalRequired, ...grant.approvalRequired];
  }
  return roles;
}

export interface VoiceConfig {
  providers: {
    stt: { primary: string; keyEnv: string; fallback: string };
    tts: { primary: string; keyEnv: string; fallback: string };
    wake: { primary: string; keyEnv: string; fallback: string };
    transport: { primary: string; keyEnvs: string[]; fallback: string };
  };
  turn: { silenceMs: number; graceMs: number; minSpeechMs: number };
  sessionTokenTtlSec: number;
  retention: { transcriptDays: number; audio: string };
}

export function loadVoiceConfig(): VoiceConfig {
  return readJson<VoiceConfig>(join(REPO_ROOT, 'config', 'voice.json'));
}
