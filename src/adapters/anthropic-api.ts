// Anthropic API adapter via the official SDK. Used automatically when
// ANTHROPIC_API_KEY is configured. Plain text completion — no tools are
// declared; the worker owns all tool execution.
//
// Claude-docs compliance (these are load-bearing, not defensive paranoia):
// - Claude 5 models run ADAPTIVE THINKING by default and thinking tokens
//   count against max_tokens, so the output budget must be sized for
//   thinking + answer, and long requests must stream (non-streaming calls
//   with large budgets risk HTTP timeouts). Both complete() and
//   completeStream() therefore use the SDK's streaming transport.
// - stop_reason 'max_tokens' means TRUNCATED output: it must surface as a
//   retryable error, never be returned as a successful completion (truncated
//   contract JSON would be misdiagnosed as a model contract violation).
// - stop_reason 'refusal' is a safety-classifier decline; the docs recommend
//   retrying/falling back server-side because false positives happen. It is
//   surfaced as retryable with kind='refusal' so callers can phrase it
//   honestly ("declined", not "unavailable").
// - A response with no text blocks at all (budget consumed by thinking)
//   must not inject an empty assistant turn into the transcript — the next
//   API call would 400 on empty content.
import Anthropic from '@anthropic-ai/sdk';
import { AdapterError, type CompletionRequest, type CompletionResult, type ModelAdapter, type StreamHandle } from './types.ts';

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5';
// Sized for adaptive thinking + a full contract answer. Streaming transport
// makes a large budget safe (no response timeout on long generations).
const MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS ?? 32000);

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
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
  }

  /** Shared streaming call: onDelta is optional (complete() ignores deltas). */
  private async runStream(req: CompletionRequest, stream?: StreamHandle): Promise<CompletionResult> {
    const s = this.getClient().messages.stream(this.requestParams(req), { signal: stream?.signal });
    if (stream) s.on('text', (delta) => stream.onDelta(delta));
    const response = await s.finalMessage();

    if (response.stop_reason === 'refusal') {
      throw new AdapterError('anthropic-api', 'model declined the request (stop_reason=refusal)', true, false, 'refusal');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new AdapterError(
        'anthropic-api',
        `output truncated at max_tokens=${MAX_TOKENS} (thinking counts against the budget); the partial text is not a usable completion`,
        true, false, 'truncated',
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (text.trim().length === 0) {
      throw new AdapterError(
        'anthropic-api',
        `model produced no text output (stop_reason=${response.stop_reason}); refusing to report an empty completion as success`,
        true, false, 'empty',
      );
    }

    return {
      text,
      usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
      model: response.model,
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    try {
      return await this.runStream(req);
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  /** True token streaming via the SDK's streaming API; abortable. */
  async completeStream(req: CompletionRequest, stream: StreamHandle): Promise<CompletionResult> {
    try {
      return await this.runStream(req, stream);
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
