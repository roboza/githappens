/**
 * The app's own HTTP (provider HttpClient, AI SDKs, cloud client) calls the global `fetch` lazily. Routing
 * the main-process global `fetch` through Electron's `net.fetch` puts every one of them on Chromium's network
 * stack: the session proxy (`session.setProxy`, driven by the Network settings), PAC/WPAD, the OS certificate
 * store and the custom-CA verify proc. electron-updater already uses Electron `net`, so it follows too.
 *
 * Non-http(s) URLs (data:, file:) keep the original Node fetch.
 */

type Fetch = typeof fetch;

/** Headers Chromium manages itself and rejects when set by the caller. */
const CHROMIUM_MANAGED = new Set([
  'content-length',
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'expect',
]);

function stripManagedHeaders(init: RequestInit | undefined): RequestInit | undefined {
  if (!init?.headers) return init;
  const h = new Headers(init.headers);
  let changed = false;
  for (const k of [...h.keys()]) {
    if (CHROMIUM_MANAGED.has(k.toLowerCase())) {
      h.delete(k);
      changed = true;
    }
  }
  return changed ? { ...init, headers: h } : init;
}

function urlOf(input: Parameters<Fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Wrap `netFetch` as a drop-in `fetch` (exported for tests). */
export function createNetBackedFetch(netFetch: Fetch, fallback: Fetch): Fetch {
  return ((input: Parameters<Fetch>[0], init?: RequestInit) => {
    if (!/^https?:/i.test(urlOf(input))) return fallback(input, init);
    return netFetch(input, stripManagedHeaders(init));
  }) as Fetch;
}

/** Install as `globalThis.fetch`; returns an uninstaller. */
export function installNetBackedFetch(netFetch: Fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = createNetBackedFetch(netFetch, original);
  return () => {
    globalThis.fetch = original;
  };
}
