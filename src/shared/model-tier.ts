// Model-tier resolution: tier -> concrete model id. The owner's per-agent
// override (agents.model_tier / model_custom) always wins over the seeded
// role default; unknown tiers fall back to letting the adapter choose.
import type { Db } from './db.ts';
import type { SystemConfig } from './config.ts';

export type ModelTier = 'fast' | 'balanced' | 'reasoning' | 'custom';

export function modelForTier(cfg: SystemConfig, tier: string, customModel?: string | null): string | undefined {
  if (tier === 'custom') return customModel ?? undefined;
  return cfg.modelTiers?.[tier];
}

export function resolveAgentModel(db: Db, cfg: SystemConfig, agentKey: string): string | undefined {
  const row = db.get<{ model_tier: string; model_custom: string | null }>(
    'SELECT model_tier, model_custom FROM agents WHERE key = ?', agentKey);
  if (!row) return undefined;
  return modelForTier(cfg, row.model_tier, row.model_custom);
}

export function converseModel(cfg: SystemConfig): string | undefined {
  return modelForTier(cfg, cfg.converseTier ?? 'balanced');
}
