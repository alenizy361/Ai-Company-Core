-- Per-agent model tiers: the orchestrator picks the lowest-cost capable
-- model per role; the owner can override per agent at any time.
ALTER TABLE agents ADD COLUMN model_tier TEXT NOT NULL DEFAULT 'balanced'
  CHECK (model_tier IN ('fast','balanced','reasoning','custom'));
ALTER TABLE agents ADD COLUMN model_custom TEXT;
