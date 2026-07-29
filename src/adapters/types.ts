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

export interface StreamHandle {
  /** Called with each raw text fragment as the model produces it. */
  onDelta: (text: string) => void;
  /** Aborting rejects the call with an AdapterError whose aborted=true. */
  signal?: AbortSignal;
}

export interface ModelAdapter {
  readonly name: 'mock' | 'claude-cli' | 'anthropic-api';
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /**
   * Optional true streaming. Resolves with the same final result as
   * complete(); callers must fall back to complete() when absent.
   */
  completeStream?(req: CompletionRequest, stream: StreamHandle): Promise<CompletionResult>;
}

export class AdapterError extends Error {
  readonly adapter: string;
  readonly retryable: boolean;
  readonly aborted: boolean;
  constructor(adapter: string, message: string, retryable: boolean, aborted = false) {
    super(message);
    this.adapter = adapter;
    this.retryable = retryable;
    this.aborted = aborted;
  }
}
