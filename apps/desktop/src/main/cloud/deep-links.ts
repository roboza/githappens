import path from 'node:path';

import type { CloudDeepLink } from '../../shared/ipc/cloud-contract';

/**
 * `githappens://` protocol handler (spec 14 §6.1): one router for `invite/<token>`,
 * `patch/<id>#k=<key>` and `suggestion/<id>`. Links arrive via the initial argv (Windows/Linux cold
 * start), the `second-instance` argv (Windows/Linux while running) or macOS `open-url`. Links seen
 * before a handler is installed are buffered.
 */

export const PROTOCOL = 'githappens';

const TOKEN_RE = /^[A-Za-z0-9_-]{8,256}$/;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** Parse one link; null for anything that is not a well-formed githappens:// route. */
export function parseDeepLink(raw: string): CloudDeepLink | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(`${PROTOCOL}:`)) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== `${PROTOCOL}:`) return null;
  // `githappens://invite/abc` → host 'invite', path '/abc'; tolerate `githappens:invite/abc`.
  const parts = [u.host, ...u.pathname.split('/')].map((p) => decodeURIComponent(p)).filter(Boolean);
  const [route, id, ...rest] = parts;
  if (!route || !id || rest.length) return null;
  switch (route.toLowerCase()) {
    case 'invite':
      return TOKEN_RE.test(id) ? { kind: 'invite', token: id, url: trimmed } : null;
    case 'patch':
      return ID_RE.test(id) ? { kind: 'patch', id, url: trimmed } : null;
    case 'suggestion':
      return ID_RE.test(id) ? { kind: 'suggestion', id, url: trimmed } : null;
    default:
      return null;
  }
}

/** True for a `githappens:` argument (filter these out before `parseOpenPathArgs`). */
export const isDeepLinkArg = (arg: string): boolean => arg.trim().toLowerCase().startsWith(`${PROTOCOL}:`);

/** Deep links contained in a process argv (Windows/Linux pass the URL as an argument). */
export function deepLinksFromArgv(argv: readonly string[]): CloudDeepLink[] {
  return argv.map(parseDeepLink).filter((l): l is CloudDeepLink => !!l);
}

/** Electron `app` subset used here (testable without Electron). */
export interface DeepLinkApp {
  isPackaged: boolean;
  setAsDefaultProtocolClient(protocol: string, path?: string, args?: string[]): boolean;
  on(event: 'open-url', listener: (event: { preventDefault(): void }, url: string) => void): unknown;
}

export interface DeepLinks {
  /** Feed a `second-instance` argv; returns true when it contained a link. */
  handleArgv(argv: readonly string[]): boolean;
  /** Feed a raw URL (e.g. pasted). */
  handleUrl(url: string): boolean;
  /** Install / replace the handler; buffered links are delivered immediately. */
  setHandler(onLink: (link: CloudDeepLink) => void): void;
}

/**
 * Register the protocol and start listening. Call once, early (before `app.whenReady()`, so macOS
 * `open-url` at launch is caught) and only in the instance that holds the single-instance lock.
 */
export function installDeepLinks(o: {
  app: DeepLinkApp;
  onLink?: (link: CloudDeepLink) => void;
  /** Initial argv (default `process.argv`). */
  argv?: readonly string[];
  /** Electron executable (default `process.execPath`). */
  execPath?: string;
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
}): DeepLinks {
  const argv = o.argv ?? process.argv;
  let handler = o.onLink ?? null;
  const buffer: CloudDeepLink[] = [];

  const deliver = (link: CloudDeepLink): void => {
    if (handler) handler(link);
    else buffer.push(link);
  };

  try {
    // In development Electron runs as `electron <appDir>`; Windows needs the script path re-passed.
    const ok =
      !o.app.isPackaged && (o.platform ?? process.platform) === 'win32' && argv[1]
        ? o.app.setAsDefaultProtocolClient(PROTOCOL, o.execPath ?? process.execPath, [path.resolve(argv[1])])
        : o.app.setAsDefaultProtocolClient(PROTOCOL);
    if (!ok) o.log?.('Could not register the githappens:// protocol handler.');
  } catch (e) {
    o.log?.(`Protocol registration failed: ${(e as Error).message}`);
  }

  o.app.on('open-url', (event, url) => {
    event.preventDefault();
    const link = parseDeepLink(url);
    if (link) deliver(link);
  });

  for (const link of deepLinksFromArgv(argv)) deliver(link);

  return {
    handleArgv(next) {
      const links = deepLinksFromArgv(next);
      links.forEach(deliver);
      return links.length > 0;
    },
    handleUrl(url) {
      const link = parseDeepLink(url);
      if (link) deliver(link);
      return !!link;
    },
    setHandler(onLink) {
      handler = onLink;
      for (const link of buffer.splice(0)) onLink(link);
    },
  };
}
