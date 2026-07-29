// Model adapter contract. The worker's execution loop is adapter-agnostic:
// every adapter is a pure text-completion endpoint. Tools are never executed
// by the model side — the worker parses the returned text and dispatches
// tools itself through the permission layer.
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  /** Rough purpose tag for logging/usage accounting. */
  purpose: 'execution' | 'planning' | 'converse' | 'eval';
}

export interface CompletionResult {
  text: string;
  usage: { input: number; output: number };
  model: string;
}

export interface ModelAdapter {
  readonly name: 'mock' | 'claude-cli' | 'anthropic-api';
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export class AdapterError extends Error {
  readonly adapter: string;
  readonly retryable: boolean;
  constructor(adapter: string, message: string, retryable: boolean) {
    super(message);
    this.adapter = adapter;
    this.retryable = retryable;
  }
}
