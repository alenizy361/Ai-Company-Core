// Official Agent SDK subagent definitions. SIRA (the parent session) is the
// orchestrator/executive — there is deliberately NO "ceo" subagent. Each
// definition gives one specialist a focused charter, the minimum tools it
// needs, and a model resolved from the owner's per-agent tier settings.
import type { Db } from '../shared/db.ts';
import type { SystemConfig } from '../shared/config.ts';
import { resolveAgentModel } from '../shared/model-tier.ts';

// Matches AgentDefinition in @anthropic-ai/claude-agent-sdk (declared
// structurally so shared code never hard-imports the SDK package).
export interface SiraAgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
}

const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const WRITE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];

const SHARED_RULES = `
You are a specialist subagent inside SIRA. You never speak to the owner — you report to the parent SIRA session.
Work ONLY on the single focused objective you were given. Return a concise final report containing:
1) what you did, 2) the concrete result with evidence (file paths, command output, data), 3) artifacts/references you produced, 4) blockers or open risks.
Never fabricate results. If you cannot complete the objective, say exactly why.`;

interface RoleSpec {
  key: string;
  description: string;
  charter: string;
  tools: string[];
  maxTurns: number;
}

const ROLES: RoleSpec[] = [
  // Keys are EXACTLY the company roster keys (config/agents.json / agents
  // table) — one identity per agent across the SDK session, the neural
  // network, the inspector, and the events. A key that is not in the roster
  // would render as a ghost ("an agent thinking that does not exist").
  { key: 'pm', maxTurns: 15, tools: [...READ_TOOLS, 'WebSearch', 'WebFetch'],
    description: 'Product management: requirements, prioritization, feature definitions, market/user research, improvement proposals.',
    charter: 'You are the product manager. Analyze requirements, research the market and users when needed, define scope, and propose prioritized improvements with clear user-value rationale.' },
  { key: 'ux', maxTurns: 15, tools: READ_TOOLS,
    description: 'UX evaluation: interaction design review, usability analysis, information architecture, accessibility.',
    charter: 'You are the UX specialist. Evaluate flows and interfaces for clarity, friction, accessibility, and consistency; give concrete, testable recommendations.' },
  { key: 'frontend', maxTurns: 30, tools: WRITE_TOOLS,
    description: 'Frontend implementation: UI code, styling, client-side logic, browser behavior.',
    charter: 'You are the frontend engineer. Implement and fix interface code precisely, matching the existing style and design system of the codebase.' },
  { key: 'backend', maxTurns: 30, tools: WRITE_TOOLS,
    description: 'Backend implementation: APIs, services, business logic, integration code.',
    charter: 'You are the backend engineer. Implement and fix server-side code precisely; preserve existing contracts and add tests where the codebase has them.' },
  { key: 'database', maxTurns: 20, tools: WRITE_TOOLS,
    description: 'Database work: schema design, migrations, query optimization, data integrity.',
    charter: 'You are the database specialist. Design safe schema changes and migrations; never destroy data; verify integrity constraints.' },
  { key: 'qa', maxTurns: 30, tools: WRITE_TOOLS,
    description: 'Quality assurance: writing/running tests, reproducing bugs, verifying fixes and acceptance criteria.',
    charter: 'You are the QA engineer. Verify claims by actually running tests and reproducing behavior; report pass/fail with real output as evidence.' },
  { key: 'security', maxTurns: 20, tools: READ_TOOLS,
    description: 'Security review: vulnerability analysis, permission audits, secret handling, safe defaults.',
    charter: 'You are the security specialist. Audit code and configuration for real vulnerabilities; rank findings by exploitability and give minimal concrete fixes.' },
  { key: 'analytics', maxTurns: 15, tools: [...READ_TOOLS, 'WebSearch', 'WebFetch'],
    description: 'Analytics and research: data analysis, metrics definitions, measurement plans, external evidence gathering.',
    charter: 'You are the analytics specialist. Analyze available data and external evidence honestly; cite sources; state confidence and sample limitations with every conclusion.' },
  { key: 'marketing', maxTurns: 12, tools: READ_TOOLS,
    description: 'Marketing: positioning, copy, launch material, audience analysis.',
    charter: 'You are the marketing specialist. Produce clear, truthful positioning and copy grounded in the actual product capabilities.' },
  { key: 'finance', maxTurns: 12, tools: READ_TOOLS,
    description: 'Finance: cost analysis, budgeting, pricing models, resource estimates.',
    charter: 'You are the finance specialist. Build transparent cost/pricing analyses; show your arithmetic and assumptions explicitly.' },
  { key: 'operations', maxTurns: 20, tools: WRITE_TOOLS,
    description: 'Operations: deployment configuration, service management, tooling, process automation.',
    charter: 'You are the operations specialist. Make infrastructure and process changes cautiously; prefer reversible steps and verify service health after changes.' },
  { key: 'support', maxTurns: 12, tools: READ_TOOLS,
    description: 'Support: troubleshooting guides, user-facing explanations, issue triage.',
    charter: 'You are the support specialist. Turn technical findings into clear, empathetic user-facing guidance.' },
];

/**
 * Build the SDK agents map. ONE activation truth: only agents whose roster
 * row is lifecycle='active' exist for the SDK session — an inactive agent
 * cannot think, run, or appear anywhere. Models honor the owner's tiers.
 */
export function buildSiraAgents(db: Db, cfg: SystemConfig): Record<string, SiraAgentDefinition> {
  const active = new Set(
    db.all<{ key: string }>(`SELECT key FROM agents WHERE lifecycle = 'active'`).map((a) => a.key),
  );
  const agents: Record<string, SiraAgentDefinition> = {};
  for (const role of ROLES) {
    if (!active.has(role.key)) continue;
    let model: string | undefined;
    try {
      model = resolveAgentModel(db, cfg, role.key);
    } catch {
      model = undefined; // unknown agent row -> inherit the parent model
    }
    agents[role.key] = {
      description: role.description,
      prompt: `${role.charter}\n${SHARED_RULES}`,
      tools: role.tools,
      model,
      maxTurns: role.maxTurns,
    };
  }
  return agents;
}

export const SIRA_AGENT_KEYS = ROLES.map((r) => r.key);
