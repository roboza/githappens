import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  AVATAR_SCHEME,
  type AvatarResolveItem,
  type AvatarResolveRequest,
  type AvatarResolveResult,
} from '../../shared/ipc/graph-contract';
import { writeFileAtomic } from '../settings/atomic-file';

/**
 * AvatarService (spec 10 §4.10, spec 04 §6.5).
 *
 * Resolves author emails and provider avatar URLs to `githappens-avatar://avatar/<hash>?s=<size>` URLs.
 * Images are fetched by the main process only (the renderer CSP has no `https:` in `img-src`), cached on
 * disk with a TTL (default 7 days, served stale while revalidating), and 404s are negatively cached
 * (default 1 day). At most 6 requests run at once.
 *
 * Email source order: GitHub noreply mapping → GitLab `/api/v4/avatar?email=` on connected GitLab hosts →
 * Gravatar (`sha256(email)`, only when `ui.useGravatar`). If none can apply (e.g. Gravatar off and no
 * provider), `resolve` returns null and the renderer draws initials without any network request.
 *
 * Emails are never written to disk: the cache stores images and miss markers keyed by hash. After a
 * restart the renderer re-resolves (registering the source again) before it requests the image.
 */

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResponseLike>;

export interface AvatarProviderHost {
  kind: string;
  host: string;
}

export interface AvatarServiceOptions {
  /** Cache directory (`userData/avatars`). */
  dir: string;
  fetch: FetchLike;
  /** `ui.useGravatar` (spec 13). */
  useGravatar: () => boolean;
  /** Connected integrations (spec 10): GitLab hosts are asked for avatars by email. */
  providerHosts?: () => AvatarProviderHost[];
  now?: () => number;
  ttlMs?: number;
  negativeTtlMs?: number;
  maxConcurrent?: number;
  /** Largest accepted image (bytes). Default 1 MiB. */
  maxBytes?: number;
  timeoutMs?: number;
  log?: (message: string, err?: unknown) => void;
}

type Source = { kind: 'email'; email: string } | { kind: 'url'; url: string };

interface IndexFile {
  /** `<key>-<px>` → time of the last miss. */
  misses: Record<string, number>;
  /** `<key>-<px>` → content type of the cached image. */
  types: Record<string, string>;
}

export interface AvatarImage {
  data: Buffer;
  contentType: string;
}

const DAY = 24 * 60 * 60 * 1000;
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/i;
const KEY_RE = /^[0-9a-f]{32}$/;

export const normalizeEmail = (e: string): string => e.trim().toLowerCase();

/** Stable cache key for a source (32 hex chars of SHA-256). */
export function avatarKey(item: AvatarResolveItem): string | null {
  if (item.email && item.email.includes('@')) {
    return createHash('sha256')
      .update(`e:${normalizeEmail(item.email)}`)
      .digest('hex')
      .slice(0, 32);
  }
  if (item.url && /^https:\/\//i.test(item.url)) {
    return createHash('sha256').update(`u:${item.url}`).digest('hex').slice(0, 32);
  }
  return null;
}

export const clampAvatarSize = (s: number | undefined): number =>
  Math.max(8, Math.min(256, Math.round(Number.isFinite(s) ? s! : 32)));

export function avatarUrl(key: string, size: number): string {
  return `${AVATAR_SCHEME}://avatar/${key}?s=${clampAvatarSize(size)}`;
}

/** Parses a protocol URL back to `{ key, size }`; null when malformed. */
export function parseAvatarUrl(url: string): { key: string; size: number } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${AVATAR_SCHEME}:`) return null;
  const key = u.pathname.replace(/^\/+/, '');
  if (!KEY_RE.test(key)) return null;
  return { key, size: clampAvatarSize(Number(u.searchParams.get('s') ?? 32)) };
}

/** GitHub noreply addresses map straight to the account avatar (spec 04 §6.5 (3)). */
export function githubNoreplyAvatar(email: string, px: number): string | null {
  const m = /^(?:(\d+)\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(normalizeEmail(email));
  if (!m) return null;
  if (m[1]) return `https://avatars.githubusercontent.com/u/${m[1]}?s=${px}&v=4`;
  return `https://github.com/${encodeURIComponent(m[2]!)}.png?size=${px}`;
}

export function gravatarUrl(email: string, px: number): string {
  const h = createHash('sha256').update(normalizeEmail(email)).digest('hex');
  return `https://www.gravatar.com/avatar/${h}?s=${px}&d=404`;
}

class Limiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class AvatarService {
  private readonly sources = new Map<string, Source>();
  private readonly inflight = new Map<string, Promise<AvatarImage | null>>();
  private readonly limiter: Limiter;
  private index: IndexFile;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly negTtl: number;
  /** Network requests made (tests: "initials mode makes zero network requests"). */
  requests = 0;

  constructor(private readonly o: AvatarServiceOptions) {
    this.now = o.now ?? Date.now;
    this.ttl = o.ttlMs ?? 7 * DAY;
    this.negTtl = o.negativeTtlMs ?? DAY;
    this.limiter = new Limiter(o.maxConcurrent ?? 6);
    this.index = this.readIndex();
  }

  /** Maps request items to protocol URLs (null = no avatar possible / known miss → initials). */
  resolve(req: AvatarResolveRequest): AvatarResolveResult {
    const size = clampAvatarSize(req.size);
    const px = Math.min(512, size * 2);
    return (req.items ?? []).map((item) => {
      const key = avatarKey(item);
      if (!key) return null;
      const source: Source = item.email
        ? { kind: 'email', email: normalizeEmail(item.email) }
        : { kind: 'url', url: item.url! };
      if (source.kind === 'email' && this.candidates(source, px).length === 0) return null;
      const missAt = this.index.misses[`${key}-${px}`];
      if (missAt !== undefined && this.now() - missAt < this.negTtl) return null;
      this.sources.set(key, source);
      return avatarUrl(key, size);
    });
  }

  /** Protocol handler body (`protocol.handle(AVATAR_SCHEME, (r) => svc.handle(r))`). */
  async handle(request: { url: string }): Promise<Response> {
    const parsed = parseAvatarUrl(request.url);
    if (!parsed) return new Response(null, { status: 400 });
    const img = await this.load(parsed.key, Math.min(512, parsed.size * 2)).catch((e: unknown) => {
      this.o.log?.('avatar load failed', e);
      return null;
    });
    if (!img) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(img.data), {
      status: 200,
      headers: {
        'content-type': img.contentType,
        'cache-control': 'max-age=86400',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  /** Cached (fresh, or stale when the source is unknown / unreachable) or freshly fetched image. */
  async load(key: string, px: number): Promise<AvatarImage | null> {
    if (!KEY_RE.test(key)) return null;
    const id = `${key}-${px}`;
    const cached = this.cachedFile(key, px);
    if (cached && this.now() - cached.mtime < this.ttl) return this.readCached(id, cached.file);
    const source = this.sources.get(key);
    if (!source) return cached ? this.readCached(id, cached.file) : null;
    const missAt = this.index.misses[id];
    if (missAt !== undefined && this.now() - missAt < this.negTtl) return null;
    let p = this.inflight.get(id);
    if (!p) {
      p = this.fetchAndStore(id, source, px).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    const fresh = await p;
    if (fresh) return fresh;
    return cached ? this.readCached(id, cached.file) : null;
  }

  /** Clears negative cache entries (e.g. after `ui.useGravatar` or integrations change). */
  invalidateMisses(): void {
    this.index.misses = {};
    this.scheduleSave();
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.writeIndex();
    }
  }

  // ------------------------------------------------------------------ internals

  private candidates(source: Source, px: number): Array<{ url: string; json?: boolean }> {
    if (source.kind === 'url') return [{ url: source.url }];
    const out: Array<{ url: string; json?: boolean }> = [];
    const gh = githubNoreplyAvatar(source.email, px);
    if (gh) out.push({ url: gh });
    for (const h of this.o.providerHosts?.() ?? []) {
      if (h.kind !== 'gitlab' || !/^[a-z0-9.-]+(:\d+)?$/i.test(h.host)) continue;
      out.push({
        url: `https://${h.host}/api/v4/avatar?email=${encodeURIComponent(source.email)}&size=${px}`,
        json: true,
      });
    }
    if (this.o.useGravatar()) out.push({ url: gravatarUrl(source.email, px) });
    return out;
  }

  private async fetchAndStore(id: string, source: Source, px: number): Promise<AvatarImage | null> {
    for (const c of this.candidates(source, px)) {
      const img = await this.limiter.run(() => this.fetchImage(c.url, c.json === true));
      if (img) {
        const file = path.join(this.o.dir, `${id}.img`);
        try {
          writeFileAtomic(file, img.data);
          this.index.types[id] = img.contentType;
          delete this.index.misses[id];
          this.scheduleSave();
        } catch (e) {
          this.o.log?.('avatar cache write failed', e);
        }
        return img;
      }
    }
    this.index.misses[id] = this.now();
    this.scheduleSave();
    return null;
  }

  private async fetchImage(url: string, json: boolean, depth = 0): Promise<AvatarImage | null> {
    if (!/^https:\/\//i.test(url)) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 10_000);
    try {
      this.requests++;
      const res = await this.o.fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > (this.o.maxBytes ?? 1024 * 1024)) return null;
      if (json) {
        // GitLab: { "avatar_url": "https://…" }
        if (depth > 0) return null;
        const next = (JSON.parse(buf.toString('utf8')) as { avatar_url?: unknown }).avatar_url;
        if (typeof next !== 'string') return null;
        // GitLab may answer with a Gravatar URL; respect the Gravatar opt-out.
        if (!this.o.useGravatar() && /(^|\.)gravatar\.com$/i.test(new URL(next).hostname)) return null;
        return this.fetchImage(next, false, depth + 1);
      }
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
      if (!IMAGE_TYPES.test(type)) return null;
      return { data: buf, contentType: type.toLowerCase() };
    } catch (e) {
      this.o.log?.(`avatar fetch failed: ${url.replace(/\?.*$/, '')}`, e);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private cachedFile(key: string, px: number): { file: string; mtime: number } | null {
    const file = path.join(this.o.dir, `${key}-${px}.img`);
    try {
      return { file, mtime: fs.statSync(file).mtimeMs };
    } catch {
      return null;
    }
  }

  private readCached(id: string, file: string): AvatarImage | null {
    try {
      return { data: fs.readFileSync(file), contentType: this.index.types[id] ?? 'image/png' };
    } catch {
      return null;
    }
  }

  private get indexFile(): string {
    return path.join(this.o.dir, 'index.json');
  }

  private readIndex(): IndexFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as Partial<IndexFile>;
      return { misses: { ...raw.misses }, types: { ...raw.types } };
    } catch {
      return { misses: {}, types: {} };
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeIndex();
    }, 1000);
    this.saveTimer.unref?.();
  }

  private writeIndex(): void {
    // drop expired misses so the index does not grow without bound
    const now = this.now();
    for (const [k, t] of Object.entries(this.index.misses))
      if (now - t >= this.negTtl) delete this.index.misses[k];
    try {
      writeFileAtomic(this.indexFile, JSON.stringify(this.index));
    } catch (e) {
      this.o.log?.('avatar index write failed', e);
    }
  }
}
