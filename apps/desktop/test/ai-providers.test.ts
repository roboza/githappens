import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AnthropicProvider, type AnthropicClientLike } from '../src/main/ai/providers/anthropic';
import { OpenAiCompatibleProvider, type FetchLike } from '../src/main/ai/providers/openai-compatible';
import { AiProviderError, type ProviderStreamOptions } from '../src/main/ai/providers/types';

type Reply = { text: string; stop: Anthropic.StopReason } | Error;

/** Fake SDK client: each `messages.stream` call consumes the next scripted reply. */
function fakeAnthropic(replies: Reply[]) {
  const calls: Anthropic.MessageStreamParams[] = [];
  const client: AnthropicClientLike = {
    messages: {
      stream(params) {
        calls.push(params);
        const reply = replies.shift()!;
        const listeners: ((d: string) => void)[] = [];
        return {
          on(_e: 'text', l: (d: string) => void) {
            listeners.push(l);
            return this;
          },
          async finalMessage() {
            await Promise.resolve();
            if (reply instanceof Error) throw reply;
            for (const chunk of reply.text.match(/.{1,5}/gs) ?? []) listeners.forEach((l) => l(chunk));
            return {
              id: 'msg',
              type: 'message',
              role: 'assistant',
              model: params.model,
              content: [{ type: 'text', text: reply.text, citations: null }],
              stop_reason: reply.stop,
              stop_sequence: null,
              stop_details: null,
              usage: { input_tokens: 10, output_tokens: 5 },
            } as unknown as Anthropic.Message;
          },
        };
      },
    },
  };
  return { calls, factory: vi.fn(() => client) };
}

const opts = (over: Partial<ProviderStreamOptions> = {}): ProviderStreamOptions => ({
  system: 'sys',
  user: 'usr',
  model: 'claude-sonnet-5-5',
  effort: 'low',
  maxTokens: 2000,
  signal: new AbortController().signal,
  onText: () => undefined,
  ...over,
});

describe('AnthropicProvider (mocked SDK client)', () => {
  it('streams text with cached system prompt, effort and structured format; no temperature', async () => {
    const f = fakeAnthropic([{ text: '{"summary":"Fix it","description":""}', stop: 'end_turn' }]);
    const p = new AnthropicProvider({ apiKey: 'k', clientFactory: f.factory });
    const deltas: string[] = [];
    const schema = z.object({ summary: z.string(), description: z.string() });
    const r = await p.stream(
      opts({ schema: { name: 'm', zod: schema, json: {} }, onText: (d) => deltas.push(d) }),
    );
    expect(r.text).toBe('{"summary":"Fix it","description":""}');
    expect(deltas.join('')).toBe(r.text);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(f.factory).toHaveBeenCalledWith({ apiKey: 'k', baseURL: 'https://api.anthropic.com' });
    const params = f.calls[0]!;
    expect(params.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
    expect(params.output_config?.effort).toBe('low');
    expect(params.output_config?.format).toMatchObject({ type: 'json_schema' });
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('thinking');
    expect(params.messages).toEqual([{ role: 'user', content: 'usr' }]);
  });

  it('retries once with doubled max_tokens, then reports invalid-output', async () => {
    const f = fakeAnthropic([
      { text: 'partial', stop: 'max_tokens' },
      { text: 'done', stop: 'end_turn' },
    ]);
    const onReset = vi.fn();
    const p = new AnthropicProvider({ apiKey: 'k', clientFactory: f.factory });
    expect((await p.stream(opts({ onReset }))).text).toBe('done');
    expect(f.calls.map((c) => c.max_tokens)).toEqual([2000, 4000]);
    expect(onReset).toHaveBeenCalledOnce();

    const g = fakeAnthropic([
      { text: 'a', stop: 'max_tokens' },
      { text: 'b', stop: 'max_tokens' },
    ]);
    const q = new AnthropicProvider({ apiKey: 'k', clientFactory: g.factory });
    await expect(q.stream(opts())).rejects.toMatchObject({ code: 'invalid-output' });
  });

  it('maps refusal and SDK typed errors to AiError codes', async () => {
    const h = new Headers({ 'retry-after': '7' });
    const apiBody = (message: string) => ({
      type: 'error',
      error: { type: 'invalid_request_error', message },
    });
    const cases: [Reply, string, number?][] = [
      [{ text: '', stop: 'refusal' }, 'refused'],
      [new Anthropic.AuthenticationError(401, {}, 'invalid x-api-key', new Headers()), 'auth'],
      [new Anthropic.RateLimitError(429, {}, 'slow down', h), 'rate-limit', 7000],
      [
        new Anthropic.BadRequestError(
          400,
          apiBody('prompt is too long: 300000 tokens > 200000 maximum'),
          undefined,
          new Headers(),
        ),
        'too-large',
      ],
      [new Anthropic.BadRequestError(400, {}, 'model: not supported', new Headers()), 'provider'],
      [new Anthropic.APIConnectionError({ message: 'ECONNRESET' }), 'network'],
      [new Anthropic.InternalServerError(500, {}, 'boom', new Headers()), 'provider'],
      [new Anthropic.APIUserAbortError(), 'cancelled'],
    ];
    for (const [reply, code, retry] of cases) {
      const f = fakeAnthropic([reply]);
      const p = new AnthropicProvider({ apiKey: 'k', clientFactory: f.factory });
      const err = await p.stream(opts()).catch((e: unknown) => e);
      expect(err, code).toBeInstanceOf(AiProviderError);
      expect((err as AiProviderError).code, code).toBe(code);
      if (retry) expect((err as AiProviderError).retryAfterMs).toBe(retry);
    }
  });
});

/** SSE response from scripted chunks. */
function sse(chunks: string[], status = 200): Response {
  const body = chunks
    .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
    .join('');
  return new Response(`${body}data: [DONE]\n\n`, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('OpenAiCompatibleProvider (fake fetch)', () => {
  const schema = { name: 'commit_message', zod: z.object({ summary: z.string() }), json: { type: 'object' } };

  it('streams chat completions with response_format json_schema and bearer auth', async () => {
    const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({
        url,
        body: JSON.parse(init.body as string),
        headers: init.headers as Record<string, string>,
      });
      return sse(['{"summary":', '"Add x"}']);
    };
    const p = new OpenAiCompatibleProvider('openai', { apiKey: 'sk-test', fetch });
    const deltas: string[] = [];
    const r = await p.stream(opts({ model: 'gpt-x', schema, onText: (d) => deltas.push(d) }));
    expect(r.text).toBe('{"summary":"Add x"}');
    expect(deltas).toEqual(['{"summary":', '"Add x"}']);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-test');
    expect(calls[0]!.body).toMatchObject({
      model: 'gpt-x',
      stream: true,
      max_completion_tokens: 2000,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'commit_message', schema: { type: 'object' } },
      },
    });
  });

  it('falls back to JSON instructions when the server rejects response_format', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      bodies.push(body);
      if (body.response_format)
        return new Response(
          JSON.stringify({
            error: { message: 'response_format is not supported', param: 'response_format' },
          }),
          {
            status: 400,
          },
        );
      return sse(['{"summary":"ok"}']);
    };
    const p = new OpenAiCompatibleProvider('openai-compatible', {
      apiKey: null,
      baseUrl: 'http://localhost:11434/v1/',
      fetch,
    });
    const r = await p.stream(opts({ model: 'llama', schema }));
    expect(r.text).toBe('{"summary":"ok"}');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty('response_format');
    expect(bodies[1]).toHaveProperty('max_tokens', 2000);
    const sys = (bodies[1]!.messages as { content: string }[])[0]!.content;
    expect(sys).toMatch(/single JSON object/);
  });

  it('uses the Azure api-key header and api-version; maps HTTP errors', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const azure = new OpenAiCompatibleProvider('azure-openai', {
      apiKey: 'az',
      baseUrl: 'https://r.openai.azure.com/openai/deployments/d1',
      fetch: async (url, init) => {
        seen = { url, headers: init.headers as Record<string, string> };
        return sse(['hi']);
      },
    });
    await azure.stream(opts());
    expect(seen!.url).toMatch(/\/deployments\/d1\/chat\/completions\?api-version=/);
    expect(seen!.headers['api-key']).toBe('az');
    expect(seen!.headers.authorization).toBeUndefined();

    const status = async (s: number, headers: Record<string, string> = {}) => {
      const p = new OpenAiCompatibleProvider('gemini', {
        apiKey: 'g',
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: { message: 'nope', code: s === 400 ? 'context_length_exceeded' : undefined },
            }),
            { status: s, headers },
          ),
      });
      return (await p.stream(opts()).catch((e: unknown) => e)) as AiProviderError;
    };
    expect((await status(401)).code).toBe('auth');
    expect(await status(429, { 'retry-after': '2' })).toMatchObject({
      code: 'rate-limit',
      retryAfterMs: 2000,
    });
    expect((await status(400)).code).toBe('too-large');
    expect((await status(500)).code).toBe('provider');
    const offline = new OpenAiCompatibleProvider('openai', {
      apiKey: 'k',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await offline.stream(opts()).catch((e: unknown) => e)).toMatchObject({ code: 'network' });
  });
});
