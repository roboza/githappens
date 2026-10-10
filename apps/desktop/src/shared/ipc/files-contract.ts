import type {
  BlameCommitInfo,
  BlameLine,
  BlobInfo,
  CombinedFile,
  FileHistoryPage,
  RepoId,
  Sha,
  SubmoduleLog,
} from '@githappens/git';

export type {
  BlobInfo,
  CombinedFile,
  FileHistoryEntry,
  FileHistoryPage,
  SubmoduleLog,
} from '@githappens/git';

/**
 * Diff / file-view channels (spec 07 §5): worktree file IO for the in-app editor, blob metadata, file
 * history, streaming blame, combined merge diffs, submodule logs and single-file patches. Revision bytes
 * (images) are served by the `githappens-rev://` protocol instead of IPC (see `revisionUrl`).
 */

export type FileEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be';

export interface WorktreeFileRead {
  exists: boolean;
  /** Raw bytes (null when missing or too large). */
  bytes: Uint8Array | null;
  size: number;
  mtimeMs: number;
  /** sha1 hex of `bytes` — pass back as `expectedHash` when saving. */
  hash: string | null;
  tooLarge?: boolean;
  /** A symlink: `bytes` holds the link target (never followed for diffs). */
  symlink?: boolean;
}

export type WorktreeWriteResult =
  | { ok: true; hash: string; mtimeMs: number }
  /** The file on disk no longer matches `expectedHash` (null hash = deleted meanwhile). */
  | { ok: false; conflict: true; hash: string | null };

export interface BlameStreamOpts {
  ignoreWhitespace?: boolean;
  detectMoves?: boolean;
  detectCopies?: boolean;
}

export interface FilesIpcContract {
  'fs:readWorktreeFile': { req: { repoId: RepoId; path: string; maxBytes?: number }; res: WorktreeFileRead };
  /** Atomic save (temp + fsync + rename). `expectedHash` (from the read) detects on-disk changes. */
  'fs:writeWorktreeFile': {
    req: { repoId: RepoId; path: string; bytes: Uint8Array; expectedHash?: string | null };
    res: WorktreeWriteResult;
  };
  /** "New file…": create an empty file (parents created); fails when it exists. */
  'fs:createFile': { req: { repoId: RepoId; path: string }; res: void };
  /** Size / existence / LFS pointer of one side of a diff (`rev` may be `:worktree` or `:index`). */
  'diff:blobInfo': { req: { repoId: RepoId; rev: string; path: string }; res: BlobInfo };
  /** Base of a three-dot comparison; null for unrelated histories. */
  'diff:mergeBase': { req: { repoId: RepoId; a: string; b: string }; res: Sha | null };
  /** "View all files": every path in the commit's tree. */
  'diff:allFiles': { req: { repoId: RepoId; rev: string }; res: string[] };
  /** Merge commit combined view (`git show --cc`). */
  'diff:combined': { req: { repoId: RepoId; sha: Sha; paths?: string[] }; res: CombinedFile[] };
  'diff:submoduleLog': {
    req: { repoId: RepoId; path: string; from?: string; to?: string };
    res: SubmoduleLog;
  };
  /** "Create patch from file": `format-patch` limited to `paths`, written to a user-chosen `.patch`. */
  'diff:savePatch': {
    req: { repoId: RepoId; sha: Sha; paths: string[] };
    res: { saved: boolean; path?: string };
  };
  /** File history with rename markers, paginated (spec 07 §4.9). */
  'history:file': {
    req: { repoId: RepoId; path: string; rev?: string; follow?: boolean; skip?: number; limit?: number };
    res: FileHistoryPage;
  };
  /** Start a streaming `blame --incremental`; results arrive as `blame:chunk` / `blame:done`. */
  'blame:start': {
    req: { repoId: RepoId; path: string; rev?: string; opts?: BlameStreamOpts };
    res: { streamId: string };
  };
  'blame:cancel': { req: { streamId: string }; res: void };
}

export interface FilesEventContract {
  /** Lines carry no content (the renderer has the file text). */
  'blame:chunk': { streamId: string; lines: BlameLine[]; commits: Record<Sha, BlameCommitInfo> };
  'blame:done': { streamId: string; error?: string };
}

export const FILES_INVOKE_CHANNELS = [
  'fs:readWorktreeFile',
  'fs:writeWorktreeFile',
  'fs:createFile',
  'diff:blobInfo',
  'diff:mergeBase',
  'diff:allFiles',
  'diff:combined',
  'diff:submoduleLog',
  'diff:savePatch',
  'history:file',
  'blame:start',
  'blame:cancel',
] as const satisfies readonly (keyof FilesIpcContract)[];

export const FILES_EVENT_CHANNELS = [
  'blame:chunk',
  'blame:done',
] as const satisfies readonly (keyof FilesEventContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const invokeExhaustive: Exhaustive<keyof FilesIpcContract, (typeof FILES_INVOKE_CHANNELS)[number]> = true;
const eventExhaustive: Exhaustive<keyof FilesEventContract, (typeof FILES_EVENT_CHANNELS)[number]> = true;
void invokeExhaustive;
void eventExhaustive;

// ---- githappens-rev:// protocol (spec 07 §5) ----

export const REVISION_SCHEME = 'githappens-rev';
/** Special revisions: the file on disk / the staged blob. */
export const WORKTREE = ':worktree';
export const INDEX = ':index';

/** `githappens-rev://blob/<repoId>/<rev>/<path>` with each part URI-encoded as one segment. */
export function revisionUrl(repoId: RepoId, rev: string, path: string): string {
  const enc = encodeURIComponent;
  return `${REVISION_SCHEME}://blob/${enc(repoId)}/${enc(rev)}/${enc(path)}`;
}

/** Inverse of `revisionUrl`; null for malformed URLs. */
export function parseRevisionUrl(url: string): { repoId: string; rev: string; path: string } | null {
  const m = /^githappens-rev:\/\/blob\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)$/.exec(url.replace(/[?#].*$/, ''));
  if (!m) return null;
  try {
    return {
      repoId: decodeURIComponent(m[1]!),
      rev: decodeURIComponent(m[2]!),
      path: decodeURIComponent(m[3]!),
    };
  } catch {
    return null;
  }
}
