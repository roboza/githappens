import type { z } from 'zod';

import type { AiEffort, AiErrorCode, AiProviderId, AiUsage } from '../../../shared/ipc/ai-contract';

/** Structured output contract for a request (zod for validation, JSON schema for non-Anthropic APIs). */
export interface OutputSchema {
  name: string;
  zod: z.ZodType;
  json: Record<string, unknown>;
}

export interface ProviderStreamOptions {
  /** Stable per feature (cacheable). */
  system: string;
  user: string;
  model: string;
  effort: AiEffort;
  maxTokens: number;
  signal: AbortSignal;
  schema?: OutputSchema;
  onText: (delta: string) => void;
  /** The provider restarted generation (e.g. retry after max_tokens): discard text received so far. */
  onReset?: () => void;
}

export interface ProviderResult {
  text: string;
  usage?: AiUsage;
}

/** spec 12 §6.3 provider interface. */
export interface AiProvider {
  readonly id: AiProviderId;
  /** Whether output is schema-constrained server-side (no repair retry needed). */
  readonly guaranteesSchema: boolean;
  stream(o: ProviderStreamOptions): Promise<ProviderResult>;
  /** Tiny request to validate key, endpoint and model. Throws AiProviderError. */
  test(model: string, signal?: AbortSignal): Promise<void>;
}

/** A provider failure already mapped to an AiError code. */
export class AiProviderError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/** `retry-after` header (seconds or HTTP date) → milliseconds. */
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Provider error text is shown to the user: keep it short and never echo anything key-like. */
export function sanitizeProviderMessage(message: string): string {
  return message
    .replace(/\b(sk|key|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .slice(0, 500);
}
