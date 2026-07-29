// Central config + path resolution. Everything test-relevant is overridable
// via environment variables so integration tests can point at temp dirs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

export interface SystemConfig {
  port: number;
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
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  // Timing overrides so integration tests can exercise lease/sweep/recovery
  // behavior in seconds instead of minutes.
  for (const [env, key] of [
    ['RABIT_LEASE_MS', 'leaseMs'],
    ['RABIT_HEARTBEAT_MS', 'heartbeatMs'],
    ['RABIT_SWEEP_MS', 'sweepMs'],
    ['RABIT_STALE_WORKER_MS', 'staleWorkerMs'],
    ['RABIT_APPROVAL_TIMEOUT_MS', 'approvalTimeoutMs'],
    ['RABIT_MAX_WALL_CLOCK_MS', 'maxWallClockMs'],
  ] as const) {
    if (process.env[env]) (cfg as unknown as Record<string, number>)[key] = Number(process.env[env]);
  }
  return cfg;
}

export function loadPaths(): Paths {
  const varDir = process.env.RABIT_VAR ? resolve(process.env.RABIT_VAR) : join(REPO_ROOT, 'var');
  return {
    root: REPO_ROOT,
    varDir,
    dbPath: process.env.RABIT_DB ?? join(varDir, 'data.db'),
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

export function loadPermissions(): Record<string, RolePolicy> {
  return readJson<{ roles: Record<string, RolePolicy> }>(join(REPO_ROOT, 'config', 'permissions.json')).roles;
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
