import fs from 'node:fs';

import {
  assertRepoPath,
  blobInfo,
  combinedDiff,
  fileHistory,
  filePatch,
  lsTree,
  mergeBase,
  submoduleLog,
  type GitService,
} from '@githappens/git';

import type { FilesIpcContract } from '../../shared/ipc/files-contract';
import type { BlameStreams } from '../files/blame-streams';
import { createWorktreeFile, readWorktreeBytes, writeWorktreeBytes } from '../files/worktree-io';
import type { HandlerContext } from './registry';

export type FilesHandlers = {
  [C in keyof FilesIpcContract]: (
    req: FilesIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => FilesIpcContract[C]['res'] | Promise<FilesIpcContract[C]['res']>;
};

export interface FilesHandlerDeps {
  repos: { get(repoId: string): GitService };
  blame: Pick<BlameStreams, 'start' | 'cancel'>;
  /** Native save dialog; resolves null when cancelled. */
  saveDialog(o: { title: string; defaultName: string }): Promise<string | null>;
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v || v.includes('\0')) throw new Error(`Invalid ${name}`);
  return v;
}
const optStr = (v: unknown, name: string): string | undefined => (v === undefined ? undefined : str(v, name));
const paths = (v: unknown): string[] => {
  if (!Array.isArray(v)) throw new Error('Invalid paths');
  return v.map((p) => assertRepoPath(str(p, 'path')));
};
function bytes(v: unknown): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new Error('Invalid bytes');
  return v;
}
const sanitizeName = (s: string): string => s.replace(/[\\/:*?"<>|\0-\x1f]+/g, '-').slice(0, 80) || 'file';

/** Spec 07 diff / file-view channels. All paths are validated (relative, in the repo, not `.git/`). */
export function createFilesHandlers(deps: FilesHandlerDeps): FilesHandlers {
  const { repos } = deps;
  const svc = (repoId: unknown): GitService => repos.get(str(repoId, 'repoId'));
  return {
    'fs:readWorktreeFile': ({ repoId, path, maxBytes }) =>
      readWorktreeBytes(svc(repoId).repo.worktreeRoot, str(path, 'path'), maxBytes),
    'fs:writeWorktreeFile': ({ repoId, path, bytes: b, expectedHash }) =>
      writeWorktreeBytes(
        svc(repoId).repo.worktreeRoot,
        str(path, 'path'),
        bytes(b),
        expectedHash === null ? null : optStr(expectedHash, 'expectedHash'),
      ),
    'fs:createFile': ({ repoId, path }) =>
      createWorktreeFile(svc(repoId).repo.worktreeRoot, str(path, 'path')),
    'diff:blobInfo': ({ repoId, rev, path }) =>
      blobInfo(svc(repoId), typeof rev === 'string' ? rev : '', str(path, 'path')),
    'diff:mergeBase': ({ repoId, a, b }) => mergeBase(svc(repoId), str(a, 'a'), str(b, 'b')),
    'diff:allFiles': ({ repoId, rev }) => lsTree(svc(repoId), str(rev, 'rev')),
    'diff:combined': ({ repoId, sha, paths: p }) =>
      combinedDiff(svc(repoId), str(sha, 'sha'), p === undefined ? [] : paths(p)),
    'diff:submoduleLog': ({ repoId, path, from, to }) =>
      submoduleLog(svc(repoId), str(path, 'path'), optStr(from, 'from'), optStr(to, 'to')),
    'diff:savePatch': async ({ repoId, sha, paths: p }) => {
      const list = paths(p);
      const text = await filePatch(svc(repoId), str(sha, 'sha'), list);
      const base = list.length === 1 ? (list[0]!.split('/').pop() ?? 'file') : 'changes';
      const target = await deps.saveDialog({
        title: 'Save patch',
        defaultName: `${sanitizeName(base)}-${sha.slice(0, 7)}.patch`,
      });
      if (!target) return { saved: false };
      await fs.promises.writeFile(target, text, 'utf8');
      return { saved: true, path: target };
    },
    'history:file': ({ repoId, path, rev, follow, skip, limit }) =>
      fileHistory(svc(repoId), {
        path: str(path, 'path'),
        rev: optStr(rev, 'rev'),
        follow: follow !== false,
        skip: typeof skip === 'number' ? skip : 0,
        limit: typeof limit === 'number' ? limit : 200,
      }),
    'blame:start': ({ repoId, path, rev, opts }) => ({
      streamId: deps.blame.start(
        svc(repoId),
        assertRepoPath(str(path, 'path')),
        optStr(rev, 'rev'),
        opts ?? {},
      ),
    }),
    'blame:cancel': ({ streamId }) => deps.blame.cancel(str(streamId, 'streamId')),
  };
}
