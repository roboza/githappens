import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod/v4';

import { AI_DEFAULT_ENDPOINTS } from '../../../shared/ipc/ai-contract';
import {
  AiProviderError,
  retryAfterMs,
  sanitizeProviderMessage,
  type AiProvider,
  type ProviderResult,
  type ProviderStreamOptions,
} from './types';

/** The subset of the SDK client the provider uses (tests inject a fake). */
export interface AnthropicClientLike {
  messages: {
    stream(
      params: Anthropic.MessageStreamParams,
      options?: { signal?: AbortSignal },
    ): {
      on(event: 'text', listener: (delta: string) => void): unknown;
      finalMessage(): Promise<Anthropic.Message>;
    };
  };
}

export type AnthropicClientFactory = (o: { apiKey: string; baseURL: string }) => AnthropicClientLike;

export const defaultAnthropicClient: AnthropicClientFactory = ({ apiKey, baseURL }) =>
  new Anthropic({ apiKey, authToken: null, baseURL, maxRetries: 2, timeout: 120_000 });

/**
 * Anthropic provider (spec 12 §6.3), main process only. Streams every request with `messages.stream`;
 * structured features add `output_config.format` (zodOutputFormat), so the final text is schema-valid JSON
 * that still streams for progressive fill. No temperature, thinking budget or assistant prefill: thinking
 * is adaptive by default on current models and depth is set with `output_config.effort`.
 */
export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic' as const;
  readonly guaranteesSchema = true;
  private readonly client: AnthropicClientLike;

  constructor(o: { apiKey: string; baseUrl?: string; clientFactory?: AnthropicClientFactory }) {
    this.client = (o.clientFactory ?? defaultAnthropicClient)({
      apiKey: o.apiKey,
      baseURL: o.baseUrl?.trim() || AI_DEFAULT_ENDPOINTS.anthropic,
    });
  }

  async stream(o: ProviderStreamOptions): Promise<ProviderResult> {
    let maxTokens = o.maxTokens;
    for (let attempt = 0; ; attempt++) {
      const msg = await this.once(o, maxTokens);
      switch (msg.stop_reason) {
        case 'refusal':
          throw new AiProviderError('refused', 'The model declined this request.');
        case 'model_context_window_exceeded':
          throw new AiProviderError(
            'too-large',
            'The changes are too large for the model. Select fewer files.',
          );
        case 'max_tokens':
          if (attempt === 0) {
            maxTokens *= 2;
            o.onReset?.();
            continue;
          }
          throw new AiProviderError('invalid-output', 'The response was cut off before it was complete.');
        default:
          break;
      }
      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return {
        text,
        usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
      };
    }
  }

  async test(model: string, signal?: AbortSignal): Promise<void> {
    const ctrl = new AbortController();
    signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
    await this.call(async () => {
      const s = this.client.messages.stream(
        {
          model,
          max_tokens: 64,
          messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
          output_config: { effort: 'low' },
        },
        { signal: ctrl.signal },
      );
      return s.finalMessage();
    }, ctrl.signal);
  }

  private once(o: ProviderStreamOptions, maxTokens: number): Promise<Anthropic.Message> {
    return this.call(async () => {
      const params: Anthropic.MessageStreamParams = {
        model: o.model,
        max_tokens: maxTokens,
        // stable per feature: cached across Regenerate clicks and multi-commit explains
        system: [{ type: 'text', text: o.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: o.user }],
        output_config: {
          effort: o.effort,
          ...(o.schema ? { format: zodOutputFormat(o.schema.zod as unknown as z.ZodType) } : {}),
        },
      };
      const stream = this.client.messages.stream(params, { signal: o.signal });
      stream.on('text', (d) => o.onText(d));
      return stream.finalMessage();
    }, o.signal);
  }

  /** Map SDK typed errors to AiError codes (spec 12 §6.3); most specific class first. */
  private async call<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw mapAnthropicError(e, signal);
    }
  }
}

export function mapAnthropicError(e: unknown, signal?: AbortSignal): AiProviderError {
  if (e instanceof AiProviderError) return e;
  if (signal?.aborted || e instanceof Anthropic.APIUserAbortError) {
    return new AiProviderError('cancelled', 'Cancelled.');
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new AiProviderError('network', 'Could not reach Anthropic. Check your connection and try again.');
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new AiProviderError('auth', 'The Anthropic API key was rejected. Check it in Preferences → AI.');
  }
  if (e instanceof Anthropic.RateLimitError) {
    const after = retryAfterMs(e.headers?.get('retry-after'));
    return new AiProviderError('rate-limit', 'Rate limited by Anthropic. Try again shortly.', after);
  }
  if (e instanceof Anthropic.BadRequestError) {
    // the API reports an over-long prompt as invalid_request_error; its message is the only signal
    if (/prompt is too long|too many tokens/i.test(e.message)) {
      return new AiProviderError('too-large', 'The changes are too large for the model. Select fewer files.');
    }
    return new AiProviderError('provider', sanitizeProviderMessage(e.message));
  }
  if (e instanceof Anthropic.APIError) {
    if (e.status === 413) {
      return new AiProviderError('too-large', 'The request is too large. Select fewer files.');
    }
    return new AiProviderError('provider', sanitizeProviderMessage(e.message));
  }
  return new AiProviderError('provider', sanitizeProviderMessage(e instanceof Error ? e.message : String(e)));
}
