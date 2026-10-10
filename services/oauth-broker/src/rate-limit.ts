/** Per-key (client IP) token bucket. In-memory: each broker instance limits independently. */
import { type RateLimitConfig } from './config.ts';

interface Bucket {
  tokens: number;
  updated: number;
}

export interface RateDecision {
  allowed: boolean;
  /** Seconds until one token is available (only meaningful when !allowed). */
  retryAfterSec: number;
}

const SWEEP_INTERVAL_MS = 60_000;
const MAX_KEYS = 100_000;

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private lastSweep: number;

  constructor(config: RateLimitConfig, now: () => number = Date.now) {
    this.capacity = config.capacity;
    this.refillPerMs = config.refillPerMinute / 60_000;
    this.now = now;
    this.lastSweep = now();
  }

  take(key: string): RateDecision {
    const t = this.now();
    this.maybeSweep(t);
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= MAX_KEYS) this.sweep(t, true);
      b = { tokens: this.capacity, updated: t };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.capacity, b.tokens + (t - b.updated) * this.refillPerMs);
      b.updated = t;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, retryAfterSec: 0 };
    }
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / this.refillPerMs / 1000)),
    };
  }

  get size(): number {
    return this.buckets.size;
  }

  private maybeSweep(t: number): void {
    if (t - this.lastSweep >= SWEEP_INTERVAL_MS) this.sweep(t, false);
  }

  /** Drop buckets that have refilled completely (they are indistinguishable from new ones). */
  private sweep(t: number, force: boolean): void {
    this.lastSweep = t;
    for (const [k, b] of this.buckets) {
      if (b.tokens + (t - b.updated) * this.refillPerMs >= this.capacity) this.buckets.delete(k);
    }
    if (force && this.buckets.size >= MAX_KEYS) this.buckets.clear();
  }
}
