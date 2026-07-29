// Deterministic mock adapter for tests, evals, and honest degradation when no
// real model is available. It never fabricates work: without a script it
// returns an explicit failure/mock-notice, and with a script it replays the
// exact turns a test or eval case provides.
//
// Scripts can be supplied two ways:
//  1. Directly via the constructor (used by the in-process eval runner).
//  2. Embedded in the conversation: any user message may contain a fenced
//     block of the form  MOCK_SCRIPT:[...json array of turn strings...]
//     which lets integration tests drive a real worker process end-to-end
//     (the script rides inside the task spec).
import type { CompletionRequest, CompletionResult, ModelAdapter } from './types.ts';

const SCRIPT_RE = /MOCK_SCRIPT:(\[[\s\S]*?\])END_MOCK_SCRIPT/;

function extractEmbeddedScript(req: CompletionRequest): string[] | null {
  for (const msg of req.messages) {
    if (msg.role !== 'user') continue;
    const match = SCRIPT_RE.exec(msg.content);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        if (Array.isArray(parsed) && parsed.every((t) => typeof t === 'string')) return parsed;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export class MockAdapter implements ModelAdapter {
  readonly name = 'mock' as const;
  private script: string[] | null;

  constructor(script?: string[]) {
    this.script = script ?? null;
  }

  complete(req: CompletionRequest): Promise<CompletionResult> {
    const script = this.script ?? extractEmbeddedScript(req);
    // The turn index is how many assistant turns already happened.
    const turnIndex = req.messages.filter((m) => m.role === 'assistant').length;

    let text: string;
    if (script && turnIndex < script.length) {
      text = script[turnIndex];
    } else if (script) {
      // Script exhausted: fail honestly instead of looping.
      text = JSON.stringify({
        action: 'fail',
        reason: `mock adapter: scripted turns exhausted (${script.length} provided, turn ${turnIndex} requested)`,
        blockers: ['mock_script_exhausted'],
      });
    } else if (req.purpose === 'planning') {
      text = JSON.stringify({
        reply:
          'MOCK MODE: no real model is configured, so no plan can be generated. Configure the claude CLI login or ANTHROPIC_API_KEY.',
        team: [],
        plan: [],
      });
    } else if (req.purpose === 'converse') {
      text =
        'MOCK MODE: no real model is configured. This is a placeholder response, not a real answer. Configure the claude CLI login or ANTHROPIC_API_KEY.';
    } else {
      text = JSON.stringify({
        action: 'fail',
        reason: 'mock adapter: no real model configured and no scripted response available',
        blockers: ['no_real_model_configured'],
      });
    }

    const input = req.system.length / 4 + req.messages.reduce((n, m) => n + m.content.length / 4, 0);
    return Promise.resolve({
      text,
      usage: { input: Math.round(input), output: Math.round(text.length / 4) },
      model: 'mock',
    });
  }
}
