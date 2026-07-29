// Effective-prompt assembly. One agent, one task, one prompt:
//   system  = ordered core bundle + THIS agent's role prompt + org context
//   user #1 = task packet: spec, acceptance criteria, verification, input
//             artifact REFERENCES (never inlined content), relevant memory
//             (hard cap), allowed tool specs + permission summary, output
//             contract reminder.
// Never any other agent's prompt; never unbounded history; per-section char
// budgets enforced with explicit truncation markers so cuts are visible.
import type { Db } from '../shared/db.ts';
import { getActiveAgentPrompt, getActiveCoreBundle } from './registry.ts';

export interface ArtifactRef {
  id: string;
  name: string;
  kind: string;
  size_bytes: number;
  content_hash: string;
  from_agent?: string | null;
}

export interface MemoryItem {
  scope: string;
  key: string;
  content: string;
}

export interface ToolSpecForPrompt {
  name: string;
  description: string;
  schema: unknown;
  approvalRequired: boolean;
}

export interface PolicySummary {
  readPaths: string[];
  writePaths: string[];
  commands: string[];
}

export interface AssembleInput {
  agentKey: string;
  contract: 'execution' | 'planning';
  companyName: string;
  objective: { id: string; title: string; description: string };
  task: {
    id: string;
    step_id: string;
    title: string;
    spec: string;
    acceptance_criteria: string[];
    verification: unknown[];
    expected_artifacts: string[];
    required_inputs: string[];
  };
  inputArtifacts: ArtifactRef[];
  handoffNotes: string[];
  memories: MemoryItem[];
  tools: ToolSpecForPrompt[];
  policy: PolicySummary;
}

export interface AssembledPrompt {
  system: string;
  firstUserMessage: string;
  promptVersionId: string;
  coreBundleHash: string;
}

const BUDGETS = {
  spec: 12000,
  memory: 2000,
  handoff: 3000,
  artifactList: 4000,
};

function clamp(text: string, budget: number, label: string): string {
  if (text.length <= budget) return text;
  return `${text.slice(0, budget)}\n[...truncated ${text.length - budget} chars of ${label}...]`;
}

export function assemblePrompt(db: Db, input: AssembleInput): AssembledPrompt {
  const core = getActiveCoreBundle(db);
  const role = getActiveAgentPrompt(db, input.agentKey);

  const system = [
    core.text,
    `\n\n# YOUR ROLE\n\n${role.content}`,
    `\n\n# COMPANY CONTEXT\n\nCompany: ${input.companyName}. You are the "${input.agentKey}" agent acting within one assigned task. All statements you make are recorded and audited.`,
  ].join('');

  const sections: string[] = [];

  sections.push(
    `# CURRENT TASK\n` +
      `Objective: ${input.objective.title}\n` +
      `Objective description: ${clamp(input.objective.description, 2000, 'objective description')}\n` +
      `Task ${input.task.step_id} (${input.task.id}): ${input.task.title}\n\n` +
      `## Specification\n${clamp(input.task.spec, BUDGETS.spec, 'spec')}`,
  );

  if (input.task.required_inputs.length) {
    sections.push(`## Required inputs\n${input.task.required_inputs.map((r) => `- ${r}`).join('\n')}`);
  }

  sections.push(
    `## Expected artifacts (you must create each via write_artifact or write_file)\n` +
      (input.task.expected_artifacts.length
        ? input.task.expected_artifacts.map((a) => `- ${a}`).join('\n')
        : '- (none declared — your summary is the deliverable)'),
  );

  sections.push(
    `## Acceptance criteria (the backend verifies these after you signal completion)\n` +
      (input.task.acceptance_criteria.length
        ? input.task.acceptance_criteria.map((c) => `- ${c}`).join('\n')
        : '- (none declared)'),
  );

  if (input.task.verification.length) {
    sections.push(`## Verification checks the backend will run\n${JSON.stringify(input.task.verification, null, 1)}`);
  }

  if (input.inputArtifacts.length) {
    const list = input.inputArtifacts
      .map(
        (a) =>
          `- id=${a.id} name="${a.name}" kind=${a.kind} size=${a.size_bytes}B sha256=${a.content_hash.slice(0, 12)}${a.from_agent ? ` from=${a.from_agent}` : ''}`,
      )
      .join('\n');
    sections.push(
      `## Input artifacts (references — read content with the read_artifact tool; do not assume contents)\n` +
        clamp(list, BUDGETS.artifactList, 'artifact list'),
    );
  }

  if (input.handoffNotes.length) {
    sections.push(`## Handoff notes from predecessor agents\n${clamp(input.handoffNotes.join('\n---\n'), BUDGETS.handoff, 'handoff notes')}`);
  }

  if (input.memories.length) {
    const memText = input.memories.map((m) => `- [${m.scope}/${m.key}] ${m.content}`).join('\n');
    sections.push(`## Relevant memory\n${clamp(memText, BUDGETS.memory, 'memory')}`);
  }

  if (input.contract === 'execution') {
    const toolLines = input.tools
      .map(
        (t) =>
          `- ${t.name}${t.approvalRequired ? ' [OWNER APPROVAL REQUIRED]' : ''}: ${t.description}\n  args schema: ${JSON.stringify(t.schema)}`,
      )
      .join('\n');
    sections.push(
      `## Tools available to you (complete list — no other tools exist for you)\n${toolLines || '- (none — you can only analyze the provided inputs and report)'}`,
    );
    sections.push(
      `## Permission policy (enforced by the backend on every call — not negotiable)\n` +
        `- readable paths: ${input.policy.readPaths.join(', ') || '(none)'}\n` +
        `- writable paths: ${input.policy.writePaths.join(', ') || '(none)'}\n` +
        `- runnable commands: ${input.policy.commands.join(', ') || '(none)'}`,
    );
    sections.push(
      `## Respond now\nFollow the OUTPUT CONTRACT from the system prompt exactly: reply with exactly ONE JSON object — a tool action, a completion, or an honest failure. No prose outside the JSON.`,
    );
  } else {
    sections.push(
      `## Respond now\nFollow the PLANNING OUTPUT CONTRACT from the system prompt exactly: reply with exactly ONE JSON object {"reply", "team", "plan"}. No prose outside the JSON.`,
    );
  }

  return {
    system,
    firstUserMessage: sections.join('\n\n'),
    promptVersionId: role.id,
    coreBundleHash: core.hash,
  };
}
