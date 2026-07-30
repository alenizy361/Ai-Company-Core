// Official Agent SDK subagent definitions. SIRA (the parent session) is the
// orchestrator/executive — there is deliberately NO "ceo" subagent. Each
// definition gives one specialist a focused charter and a model resolved
// from the owner's per-agent tier settings.
//
// Security boundary (Phase 2): tool grants are derived from
// config/permissions.json — the SAME policy source the worker pipeline
// uses — not a separate hardcoded list. No subagent (and no parent session;
// see session.ts) is ever granted the SDK's native Bash / unrestricted
// Write / unrestricted Edit. Native Read/Glob/Grep remain (read-only, path-
// checked in session.ts's canUseTool); every write/execute capability is a
// custom tool that runs through dispatchTool() — the SAME single
// enforcement point (path containment, command allowlisting, approvals,
// audit, timeout, output limits) the worker pipeline already uses.
import type { Db } from '../shared/db.ts';
import type { SystemConfig, Paths } from '../shared/config.ts';
import { loadPermissions } from '../shared/config.ts';
import { resolveAgentModel } from '../shared/model-tier.ts';
import { buildRoleToolServer } from '../tools/sdk-bridge.ts';

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

// The registry tool names that have an in-process MCP replacement (built by
// buildRoleToolServer). read_file/list_dir/search are intentionally NOT
// mapped — the SDK's own native Read/Glob/Grep already cover that ground
// with better ergonomics; policy.tools listing them is meaningful only to
// the worker pipeline, which has no native equivalent.
const MCP_TOOL_NAMES = new Set([
  'write_file', 'edit_file', 'run_command', 'read_artifact', 'write_artifact', 'memory_search', 'memory_write', 'task_note',
]);

const SHARED_RULES = `
You are a specialist subagent inside SIRA. You never speak to the owner — you report to the parent SIRA session.
Work ONLY on the single focused objective you were given. Return a concise final report containing:
1) what you did, 2) the concrete result with evidence (file paths, command output, data), 3) artifacts/references you produced, 4) blockers or open risks.
Never fabricate results. If you cannot complete the objective, say exactly why.`;

interface RoleSpec {
  key: string;
  description: string;
  charter: string;
  maxTurns: number;
}

const ROLES: RoleSpec[] = [
  // Keys are EXACTLY the company roster keys (config/agents.json / agents
  // table) — one identity per agent across the SDK session, the neural
  // network, the inspector, and the events. A key that is not in the roster
  // would render as a ghost ("an agent thinking that does not exist").
  { key: 'pm', maxTurns: 15,
    description: 'Product management: requirements, prioritization, feature definitions, market/user research, improvement proposals.',
    charter: 'You are the product manager. Analyze requirements, research the market and users when needed, define scope, and propose prioritized improvements with clear user-value rationale.' },
  { key: 'ux', maxTurns: 15,
    description: 'UX evaluation: interaction design review, usability analysis, information architecture, accessibility.',
    charter: 'You are the UX specialist. Evaluate flows and interfaces for clarity, friction, accessibility, and consistency; give concrete, testable recommendations.' },
  { key: 'frontend', maxTurns: 30,
    description: 'Frontend implementation: UI code, styling, client-side logic, browser behavior.',
    charter: 'You are the frontend engineer. Implement and fix interface code precisely, matching the existing style and design system of the codebase.' },
  { key: 'backend', maxTurns: 30,
    description: 'Backend implementation: APIs, services, business logic, integration code.',
    charter: 'You are the backend engineer. Implement and fix server-side code precisely; preserve existing contracts and add tests where the codebase has them.' },
  { key: 'database', maxTurns: 20,
    description: 'Database work: schema design, migrations, query optimization, data integrity.',
    charter: 'You are the database specialist. Design safe schema changes and migrations; never destroy data; verify integrity constraints.' },
  { key: 'qa', maxTurns: 30,
    description: 'Quality assurance: writing/running tests, reproducing bugs, verifying fixes and acceptance criteria.',
    charter: 'You are the QA engineer. Verify claims by actually running tests and reproducing behavior; report pass/fail with real output as evidence.' },
  { key: 'security', maxTurns: 20,
    description: 'Security review: vulnerability analysis, permission audits, secret handling, safe defaults.',
    charter: 'You are the security specialist. Audit code and configuration for real vulnerabilities; rank findings by exploitability and give minimal concrete fixes.' },
  { key: 'analytics', maxTurns: 15,
    description: 'Analytics and research: data analysis, metrics definitions, measurement plans, external evidence gathering.',
    charter: 'You are the analytics specialist. Analyze available data and external evidence honestly; cite sources; state confidence and sample limitations with every conclusion.' },
  { key: 'marketing', maxTurns: 12,
    description: 'Marketing: positioning, copy, launch material, audience analysis.',
    charter: 'You are the marketing specialist. Produce clear, truthful positioning and copy grounded in the actual product capabilities.' },
  { key: 'finance', maxTurns: 12,
    description: 'Finance: cost analysis, budgeting, pricing models, resource estimates.',
    charter: 'You are the finance specialist. Build transparent cost/pricing analyses; show your arithmetic and assumptions explicitly.' },
  { key: 'operations', maxTurns: 20,
    description: 'Operations: deployment configuration, service management, tooling, process automation.',
    charter: 'You are the operations specialist. Make infrastructure and process changes cautiously; prefer reversible steps and verify service health after changes.' },
  { key: 'support', maxTurns: 12,
    description: 'Support: troubleshooting guides, user-facing explanations, issue triage.',
    charter: 'You are the support specialist. Turn technical findings into clear, empathetic user-facing guidance.' },
];

export interface SiraToolBundle {
  agents: Record<string, SiraAgentDefinition>;
  /** Keyed exactly as they must appear in Options.mcpServers — in-process
   *  instance-bearing MCP servers can only be registered at the top level;
   *  each AgentDefinition.tools references its OWN server's qualified tool
   *  names only, which is what actually isolates roles from each other
   *  (the server existing globally does not grant access to it). */
  mcpServers: Record<string, ReturnType<typeof buildRoleToolServer>['server']>;
}

/**
 * Build the SDK agents map + their tool servers. ONE activation truth: only
 * agents whose roster row is lifecycle='active' exist for the SDK session —
 * an inactive agent cannot think, run, or appear anywhere. Models honor the
 * owner's tiers. Tool grants come from the SAME permissions.json the worker
 * pipeline uses (loadPermissions() already merges self-dev grants) — one
 * policy, not two.
 */
export function buildSiraAgents(
  db: Db, cfg: SystemConfig, paths: Paths, workspaceRoot: string, conversationId: string,
): SiraToolBundle {
  const active = new Set(
    db.all<{ key: string }>(`SELECT key FROM agents WHERE lifecycle = 'active'`).map((a) => a.key),
  );
  const permissions = loadPermissions();
  const agents: Record<string, SiraAgentDefinition> = {};
  const mcpServers: Record<string, ReturnType<typeof buildRoleToolServer>['server']> = {};

  for (const role of ROLES) {
    if (!active.has(role.key)) continue;
    const policy = permissions[role.key];
    if (!policy) continue; // no policy defined for this role — grant nothing rather than guess

    let model: string | undefined;
    try {
      model = resolveAgentModel(db, cfg, role.key);
    } catch {
      model = undefined; // unknown agent row -> inherit the parent model
    }

    const serverKey = `sira-${role.key}`;
    mcpServers[serverKey] = buildRoleToolServer({
      db, cfg, policy, agentKey: role.key, workspaceRoot, artifactsDir: paths.artifactsDir, orgId: cfg.orgId, conversationId,
    }).server;
    const customTools = policy.tools.filter((t) => MCP_TOOL_NAMES.has(t)).map((t) => `mcp__${serverKey}__${t}`);
    const nativeReadTools = policy.paths.read.length > 0 ? ['Read', 'Glob', 'Grep'] : [];

    agents[role.key] = {
      description: role.description,
      prompt: `${role.charter}\n${SHARED_RULES}`,
      tools: [...nativeReadTools, ...customTools],
      model,
      maxTurns: role.maxTurns,
    };
  }
  return { agents, mcpServers };
}

export const SIRA_AGENT_KEYS = ROLES.map((r) => r.key);
