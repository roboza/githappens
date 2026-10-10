import fs from 'node:fs';

import { lfsObjectPath, parseLfsPointer, type GitService } from '@githappens/git';

import { INDEX, parseRevisionUrl, REVISION_SCHEME, WORKTREE } from '../../shared/ipc/files-contract';
import { safeWorktreePath } from './worktree-io';

/**
 * `githappens-rev://blob/<repoId>/<rev>/<path>` (spec 07 §5): raw blob bytes for image diffs, so large images
 * never travel through IPC as data URLs. `rev` may be a revision, `:worktree` or `:index`. LFS pointers
 * whose object is available locally are resolved to the object's bytes.
 */

/** Never serve more than this (spec 07 §4.6: images over 50 MB are not rendered). */
export const REVISION_MAX_BYTES = 50 * 1024 * 1024;

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};

export function mimeFor(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

export interface RevisionResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
}

export interface RevisionProtocolDeps {
  /** Throws for unknown/closed repos. */
  service(repoId: string): GitService;
  maxBytes?: number;
}

const text = (status: number, msg: string): RevisionResponse => ({
  status,
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  body: Buffer.from(msg, 'utf8'),
});

async function resolveLfs(svc: GitService, data: Buffer, max: number): Promise<Buffer> {
  if (data.length > 1024) return data;
  const ptr = parseLfsPointer(data.toString('utf8'));
  if (!ptr) return data;
  const obj = lfsObjectPath(svc, ptr.oid);
  if (!obj) return data;
  const st = await fs.promises.stat(obj);
  if (st.size > max) return data;
  return fs.promises.readFile(obj);
}

/** Pure request → response mapping (unit-tested without Electron). */
export async function serveRevision(url: string, deps: RevisionProtocolDeps): Promise<RevisionResponse> {
  const max = deps.maxBytes ?? REVISION_MAX_BYTES;
  const req = parseRevisionUrl(url);
  if (!req || !req.path || req.path.includes('\0')) return text(400, 'Bad revision URL');
  let svc: GitService;
  try {
    svc = deps.service(req.repoId);
  } catch {
    return text(404, 'Unknown repository');
  }
  let data: Buffer | null;
  try {
    if (req.rev === WORKTREE) {
      const abs = safeWorktreePath(svc.repo.worktreeRoot, req.path);
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(abs);
      } catch {
        return text(404, 'Not found');
      }
      if (!st.isFile()) return text(404, 'Not found');
      if (st.size > max) return text(413, 'Too large');
      data = await fs.promises.readFile(abs);
    } else {
      if (req.rev.startsWith('-') || /[\0\r\n]/.test(req.rev)) return text(400, 'Bad revision');
      const r = await svc.blobs().readBytes(req.rev === INDEX ? ':0' : req.rev, req.path, max);
      if (r.missing) return text(404, 'Not found');
      if (r.tooLarge || !r.data) return text(413, 'Too large');
      data = r.data;
    }
  } catch (e) {
    return text(403, e instanceof Error ? e.message : 'Forbidden');
  }
  const body = await resolveLfs(svc, data, max);
  return {
    status: 200,
    headers: {
      'Content-Type': mimeFor(req.path),
      'Content-Length': String(body.length),
      'X-Content-Type-Options': 'nosniff',
      // the image diff's Difference mode reads pixels through a canvas (needs CORS to stay untainted)
      'Access-Control-Allow-Origin': '*',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'Cache-Control': req.rev === WORKTREE || req.rev === INDEX ? 'no-store' : 'max-age=3600',
    },
    body,
  };
}

/** Pass to `protocol.registerSchemesAsPrivileged` before `app.whenReady()`. */
export const REVISION_SCHEME_PRIVILEGES = {
  scheme: REVISION_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
} as const;

/** Minimal subset of Electron's `protocol` (keeps this module testable). */
export interface ProtocolLike {
  handle(scheme: string, handler: (request: Request) => Promise<Response> | Response): void;
}

/** Register the `githappens-rev://` handler (after `app.whenReady()`). */
export function registerRevisionProtocol(protocol: ProtocolLike, deps: RevisionProtocolDeps): void {
  protocol.handle(REVISION_SCHEME, async (request) => {
    const r = await serveRevision(request.url, deps);
    return new Response(r.body ? new Uint8Array(r.body) : null, { status: r.status, headers: r.headers });
  });
}
