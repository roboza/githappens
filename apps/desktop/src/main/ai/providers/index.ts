import type { AiProviderId } from '../../../shared/ipc/ai-contract';
import { AnthropicProvider, type AnthropicClientFactory } from './anthropic';
import { OpenAiCompatibleProvider, type FetchLike } from './openai-compatible';
import type { AiProvider } from './types';

export * from './types';
export { AnthropicProvider, mapAnthropicError, type AnthropicClientFactory } from './anthropic';
export { OpenAiCompatibleProvider, type FetchLike } from './openai-compatible';

export interface ProviderConfig {
  provider: AiProviderId;
  apiKey: string | null;
  baseUrl?: string;
}

export type ProviderFactory = (c: ProviderConfig) => AiProvider;

/** ProviderRegistry (spec 12 §6.3). Gemini goes through its OpenAI-compatible endpoint. */
export function createProviderFactory(
  o: { anthropicClient?: AnthropicClientFactory; fetch?: FetchLike } = {},
) {
  return (c: ProviderConfig): AiProvider =>
    c.provider === 'anthropic'
      ? new AnthropicProvider({
          apiKey: c.apiKey ?? '',
          baseUrl: c.baseUrl,
          clientFactory: o.anthropicClient,
        })
      : new OpenAiCompatibleProvider(c.provider, { apiKey: c.apiKey, baseUrl: c.baseUrl, fetch: o.fetch });
}
