import { AI_DEFAULT_ENDPOINTS, type AiProviderId } from '../../../shared/ipc/ai-contract';
import {
  AiProviderError,
  retryAfterMs,
  sanitizeProviderMessage,
  type AiProvider,
  type ProviderResult,
  type ProviderStreamOptions,
} from './types';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const AZURE_API_VERSION = '2024-10-21';

const JSON_INSTRUCTIONS =
  '\n\n# Output format\nRespond with a single JSON object only — no markdown fences, no prose before or after it. ' +
  'It must match this JSON schema:\n';

/**
 * Chat Completions over `fetch` (spec 12 §6.3 "other providers"): OpenAI, Azure OpenAI, Gemini's
 * OpenAI-compatible endpoint and local servers (Ollama, LM Studio). Structured features ask for
 * `response_format: json_schema`; when a server rejects that, the request is repeated once with JSON
 * instructions in the system prompt instead (validation + one repair retry happen in AiService).
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly guaranteesSchema = false;
  private readonly fetch: FetchLike;
  private readonly base: string;
  /** Learned per instance: the server rejected `response_format: json_schema`. */
  private noJsonSchema = false;

  constructor(
    readonly id: Exclude<AiProviderId, 'anthropic'>,
    private readonly o: { apiKey: string | null; baseUrl?: string; fetch?: FetchLike },
  ) {
    this.fetch = o.fetch ?? ((url, init) => globalThis.fetch(url, init));
    const base = o.baseUrl?.trim() || AI_DEFAULT_ENDPOINTS[id];
    if (!base) throw new AiProviderError('provider', 'Set the endpoint URL in Preferences → AI.');
    this.base = base.replace(/\/+$/, '');
  }

  private url(): string {
    if (this.id !== 'azure-openai') return `${this.base}/chat/completions`;
    return this.base.includes('api-version=')
      ? this.base
      : `${this.base}/chat/completions?api-version=${AZURE_API_VERSION}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
    if (this.o.apiKey) {
      if (this.id === 'azure-openai') h['api-key'] = this.o.apiKey;
      else h.authorization = `Bearer ${this.o.apiKey}`;
    }
    return h;
  }

  private body(o: ProviderStreamOptions, useSchema: boolean, maxTokens: number): Record<string, unknown> {
    const system =
      o.schema && !useSchema ? `${o.system}${JSON_INSTRUCTIONS}${JSON.stringify(o.schema.json)}` : o.system;
    const body: Record<string, unknown> = {
      model: o.model,
      stream: true,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: o.user },
      ],
    };
    // OpenAI's newer models only accept max_completion_tokens; local servers know max_tokens
    if (this.id === 'openai' || this.id === 'azure-openai') body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;
    if (this.id === 'openai') body.stream_options = { include_usage: true };
    if (o.schema && useSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: o.schema.name, schema: o.schema.json, strict: false },
      };
    }
    return body;
  }

  async stream(o: ProviderStreamOptions): Promise<ProviderResult> {
    const useSchema = !!o.schema && !this.noJsonSchema;
    try {
      return await this.request(o, useSchema);
    } catch (e) {
      if (useSchema && e instanceof SchemaUnsupported) {
        this.noJsonSchema = true;
        return this.request(o, false);
      }
      throw e;
    }
  }

  async test(model: string, signal?: AbortSignal): Promise<void> {
    await this.request(
      {
        system: 'You are a connection test.',
        user: 'Reply with the single word OK.',
        model,
        effort: 'low',
        maxTokens: 64,
        signal: signal ?? new AbortController().signal,
        onText: () => undefined,
      },
      false,
    );
  }

  private async request(o: ProviderStreamOptions, useSchema: boolean): Promise<ProviderResult> {
    let res: Response;
    try {
      res = await this.fetch(this.url(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.body(o, useSchema, o.maxTokens)),
        signal: o.signal,
      });
    } catch (e) {
      if (o.signal.aborted) throw new AiProviderError('cancelled', 'Cancelled.');
      throw new AiProviderError(
        'network',
        `Could not reach ${this.base}. Check the endpoint and your connection. (${sanitizeProviderMessage((e as Error).message)})`,
      );
    }
    if (!res.ok) throw await this.httpError(res, useSchema);
    try {
      return await this.readStream(res, o);
    } catch (e) {
      if (o.signal.aborted) throw new AiProviderError('cancelled', 'Cancelled.');
      if (e instanceof AiProviderError) throw e;
      throw new AiProviderError(
        'network',
        `The connection was interrupted: ${sanitizeProviderMessage((e as Error).message)}`,
      );
    }
  }

  private async httpError(res: Response, usedSchema: boolean): Promise<Error> {
    let message = `${res.status} ${res.statusText}`.trim();
    let code: string | undefined;
    let param: string | undefined;
    try {
      const j = (await res.json()) as {
        error?: { message?: string; code?: string; param?: string } | string;
      };
      if (typeof j.error === 'string') message = j.error;
      else if (j.error) {
        message = j.error.message ?? message;
        code = j.error.code ?? undefined;
        param = j.error.param ?? undefined;
      }
    } catch {
      /* not JSON */
    }
    const msg = sanitizeProviderMessage(message);
    if (res.status === 401 || res.status === 403)
      return new AiProviderError(
        'auth',
        `The API key was rejected (${res.status}). Check it in Preferences → AI.`,
      );
    if (res.status === 429)
      return new AiProviderError(
        'rate-limit',
        'Rate limited by the provider. Try again shortly.',
        retryAfterMs(res.headers.get('retry-after')),
      );
    if (res.status === 413 || code === 'context_length_exceeded')
      return new AiProviderError('too-large', 'The changes are too large for the model. Select fewer files.');
    if (
      usedSchema &&
      (res.status === 400 || res.status === 422) &&
      (param === 'response_format' || /response_format|json_schema/i.test(message))
    )
      return new SchemaUnsupported(msg);
    return new AiProviderError('provider', msg);
  }

  /** Server-sent events: `data: {chunk}` lines until `data: [DONE]`. */
  private async readStream(res: Response, o: ProviderStreamOptions): Promise<ProviderResult> {
    let text = '';
    let usage: ProviderResult['usage'];
    let finish: string | null = null;
    const handle = (data: string): void => {
      if (data === '[DONE]') return;
      let j: {
        choices?: {
          delta?: { content?: string | null };
          message?: { content?: string };
          finish_reason?: string | null;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        error?: { message?: string };
      };
      try {
        j = JSON.parse(data);
      } catch {
        return;
      }
      if (j.error)
        throw new AiProviderError('provider', sanitizeProviderMessage(j.error.message ?? 'Provider error'));
      const c = j.choices?.[0];
      const delta = c?.delta?.content ?? c?.message?.content ?? '';
      if (delta) {
        text += delta;
        o.onText(delta);
      }
      if (c?.finish_reason) finish = c.finish_reason;
      if (j.usage)
        usage = { inputTokens: j.usage.prompt_tokens ?? 0, outputTokens: j.usage.completion_tokens ?? 0 };
    };
    const ct = res.headers.get('content-type') ?? '';
    if (!res.body || ct.includes('application/json')) {
      // a server that ignored `stream: true`
      handle(await res.text());
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line.startsWith('data:')) handle(line.slice(5).trim());
        }
      }
      if (buf.startsWith('data:')) handle(buf.slice(5).trim());
    }
    if (finish === 'content_filter')
      throw new AiProviderError('refused', 'The provider declined this request.');
    if (finish === 'length' && !text.trim())
      throw new AiProviderError('invalid-output', 'The response was cut off before it was complete.');
    return { text, usage };
  }
}

class SchemaUnsupported extends Error {}
