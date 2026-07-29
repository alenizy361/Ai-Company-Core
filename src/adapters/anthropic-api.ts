// Anthropic API adapter via the official SDK. Used automatically when
// ANTHROPIC_API_KEY is configured. Plain text completion — no tools are
// declared; the worker owns all tool execution.
import Anthropic from '@anthropic-ai/sdk';
import { AdapterError, type CompletionRequest, type CompletionResult, type ModelAdapter, type StreamHandle } from './types.ts';

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5';

export class AnthropicApiAdapter implements ModelAdapter {
  readonly name = 'anthropic-api' as const;
  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    if (!this.client) this.client = new Anthropic();
    return this.client;
  }

  /**
   * Stable system prompt is marked for prompt caching (assemble.ts keeps the
   * immutable core first and all dynamic task context in trailing sections,
   * so the cache prefix stays warm across turns).
   */
  private requestParams(req: CompletionRequest): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model: req.model ?? DEFAULT_MODEL,
      max_tokens: 16000,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    try {
      const response = await this.getClient().messages.create(this.requestParams(req));

      if (response.stop_reason === 'refusal') {
        throw new AdapterError('anthropic-api', 'model declined the request (stop_reason=refusal)', false);
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      return {
        text,
        usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
        model: response.model,
      };
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  /** True token streaming via the SDK's streaming API; abortable. */
  async completeStream(req: CompletionRequest, stream: StreamHandle): Promise<CompletionResult> {
    try {
      const s = this.getClient().messages.stream(this.requestParams(req), { signal: stream.signal });
      s.on('text', (delta) => stream.onDelta(delta));
      const response = await s.finalMessage();
      if (response.stop_reason === 'refusal') {
        throw new AdapterError('anthropic-api', 'model declined the request (stop_reason=refusal)', false);
      }
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
      return {
        text,
        usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
        model: response.model,
      };
    } catch (err) {
      if (stream.signal?.aborted) {
        throw new AdapterError('anthropic-api', 'stream aborted by caller', false, true);
      }
      throw this.wrapError(err);
    }
  }

  private wrapError(err: unknown): AdapterError {
    if (err instanceof AdapterError) return err;
    if (err instanceof Anthropic.RateLimitError) {
      return new AdapterError('anthropic-api', `rate limited: ${err.message}`, true);
    }
    if (err instanceof Anthropic.InternalServerError) {
      return new AdapterError('anthropic-api', `server error: ${err.message}`, true);
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return new AdapterError('anthropic-api', `connection error: ${err.message}`, true);
    }
    if (err instanceof Anthropic.APIError) {
      return new AdapterError('anthropic-api', `API error ${err.status}: ${err.message}`, false);
    }
    return new AdapterError('anthropic-api', err instanceof Error ? err.message : String(err), false);
  }
}
