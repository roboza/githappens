import { useEffect, useState, useSyncExternalStore } from 'react';

import { authorInitials } from '../lib/format';
import { useSetting } from '../stores/settings';
import { graphInvoke } from '../views/graph/graph-ipc';

/**
 * Avatars (spec 04 §6.5, spec 10 §4.10).
 *
 * Images come only from the main-process AvatarService through `githappens-avatar://` URLs; the renderer
 * CSP does not allow remote images. Author emails and provider avatar URLs are resolved in batches via
 * `avatar:resolve` (null = no avatar → initials). With `ui.authorDisplay: 'initials'` author avatars are
 * never requested.
 */

export interface AvatarSource {
  email?: string;
  /** Provider avatar URL (https) or an already-resolved `data:` / `githappens-avatar:` URL. */
  url?: string;
}

type Pending = { item: AvatarSource; size: number; key: string };

const resolved = new Map<string, string | null>();
/**
 * Image URLs that failed to load. Shared by every <Avatar> so a remounted row (graph virtualization) does
 * not refetch a broken image and re-render to initials on every scroll frame.
 */
const failedImages = new Set<string>();
const queue = new Map<string, Pending>();
const listeners = new Set<() => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let version = 0;
let policy = '';

const bump = (): void => {
  version++;
  for (const l of listeners) l();
};

export const subscribeAvatars = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
export const getAvatarVersion = (): number => version;

/** Clears resolved URLs when the avatar policy (e.g. `ui.useGravatar`) changes. */
export function setAvatarPolicy(key: string): void {
  if (key === policy) return;
  const first = policy === '';
  policy = key;
  if (first) return;
  resolved.clear();
  failedImages.clear();
  bump();
}

function sourceKey(item: AvatarSource, size: number): string | null {
  if (item.url) return `u:${item.url}:${size}`;
  if (item.email && item.email.includes('@')) return `e:${item.email.trim().toLowerCase()}:${size}`;
  return null;
}

async function flush(): Promise<void> {
  flushTimer = null;
  const batch = [...queue.values()];
  queue.clear();
  const bySize = new Map<number, Pending[]>();
  for (const p of batch) bySize.set(p.size, [...(bySize.get(p.size) ?? []), p]);
  await Promise.all(
    [...bySize].map(async ([size, list]) => {
      let urls: (string | null)[] = [];
      try {
        urls = await graphInvoke('avatar:resolve', { items: list.map((p) => p.item), size });
      } catch {
        /* service unavailable: initials */
      }
      list.forEach((p, i) => resolved.set(p.key, urls[i] ?? null));
    }),
  );
  bump();
}

/**
 * Protocol URL for an avatar: a string when ready, `null` when there is none (draw initials),
 * `undefined` while the batch request is in flight (subscribe with `subscribeAvatars`).
 */
export function avatarSrc(item: AvatarSource, size: number): string | null | undefined {
  if (item.url && /^(data:|blob:|githappens-avatar:)/.test(item.url)) return item.url;
  if (item.url && !/^https:\/\//i.test(item.url)) return null;
  const key = sourceKey(item, size);
  if (!key) return null;
  if (resolved.has(key)) return resolved.get(key)!;
  if (!queue.has(key)) {
    queue.set(key, { item: item.url ? { url: item.url } : { email: item.email }, size, key });
    flushTimer ??= setTimeout(() => void flush(), 30);
  }
  return undefined;
}

/** Whether an avatar image URL already failed to load (show initials instead). */
export const avatarFailed = (src: string): boolean => failedImages.has(src);

/** Records a broken avatar image and notifies subscribers (hook-free renderers such as graph rows). */
export function markAvatarFailed(src: string): void {
  if (failedImages.has(src)) return;
  failedImages.add(src);
  bump();
}

/** Keeps the renderer avatar cache in sync with the avatar settings; returns whether author avatars are on. */
export function useAvatarPolicy(): boolean {
  const display = useSetting('ui.authorDisplay') ?? 'avatar';
  const gravatar = useSetting('ui.useGravatar') ?? true;
  useEffect(() => setAvatarPolicy(`${display}|${gravatar}`), [display, gravatar]);
  return display === 'avatar';
}

/** Avatar image (author email or provider URL) with an initials fallback. */
export function Avatar({
  name,
  email,
  url,
  size = 20,
  className,
}: {
  name: string;
  email: string;
  url?: string;
  size?: number;
  className?: string;
}) {
  const avatarsOn = useAvatarPolicy();
  useSyncExternalStore(subscribeAvatars, getAvatarVersion);
  const [failed, setFailed] = useState<string | null>(null);
  const src = url ? avatarSrc({ url }, size) : avatarsOn ? avatarSrc({ email }, size) : null;
  if (src && failed !== src && !failedImages.has(src)) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className={className}
        style={{ flex: 'none', borderRadius: '50%', objectFit: 'cover' }}
        draggable={false}
        onError={() => {
          failedImages.add(src);
          setFailed(src);
        }}
      />
    );
  }
  const { text, color } = authorInitials(name, email);
  return (
    <span
      aria-hidden
      className={className}
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        flex: 'none',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        color: '#fff',
        fontSize: Math.max(9, Math.round(size * 0.4)),
        fontWeight: 600,
        letterSpacing: '0.02em',
      }}
    >
      {text}
    </span>
  );
}
