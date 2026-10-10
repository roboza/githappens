import type { RepoId } from '@githappens/git/types';

import type { ExternalDiffRequest } from '../../../shared/ipc/tools-contract';
import type { MenuEntry } from '../components/ContextMenu';
import { wipDiffSpec } from '../views/composer/staging-helpers';
import { formatChord } from '../commands/keybindings';
import {
  copyFullPath,
  openDefault,
  openExternalDiff,
  openExternalMergeTool,
  openInEditor,
  openInTerminal,
  repoRoot,
  showInFolder,
  showInFolderLabel,
} from './actions';

/** The diff a file row stands for, so "External diff" opens the same two sides (spec 07 §2.3). */
export type FileDiffContext = Omit<ExternalDiffRequest, 'repoId' | 'path' | 'spec'> & {
  spec: NonNullable<ExternalDiffRequest['spec']>;
};

const isMac = (): boolean => typeof window !== 'undefined' && window.api?.platform === 'darwin';

/**
 * "Open in…" entries for a file context menu (spec 12 §4.10, spec 07 §2.3): external editor, default program,
 * show in folder, external diff (when the row is a diff) and copy full path.
 */
export function fileToolsMenu(
  repoId: RepoId,
  path: string,
  o: { diff?: FileDiffContext; line?: number; conflicted?: boolean } = {},
): MenuEntry[] {
  const file = { repoId, path };
  return [
    { label: 'Open in external editor', onSelect: () => void openInEditor(file, o.line) },
    { label: 'Open with default program', onSelect: () => void openDefault(file) },
    { label: showInFolderLabel(), onSelect: () => void showInFolder(file) },
    ...(o.diff
      ? [
          {
            label: 'Open in external diff tool',
            shortcut: formatChord('mod+d', isMac()),
            onSelect: () => void openExternalDiff({ repoId, path, ...o.diff! }),
          },
        ]
      : []),
    ...(o.conflicted
      ? [{ label: 'Open in external merge tool', onSelect: () => void openExternalMergeTool(repoId, path) }]
      : []),
    { label: 'Copy full path', onSelect: () => void copyFullPath(file) },
  ];
}

interface FileRowLike {
  path: string;
  oldPath?: string;
  /** Raw path keys for names that are not valid UTF-8 (spec 02 §8). */
  rawKey?: string;
  oldRawKey?: string;
  /** Status letter (`A`, `M`, `D`, `R`…). */
  status: string;
  untracked?: boolean;
}

/** External-diff sides of a WIP row, matching the staging panel's diff view. */
export function wipDiffContext(f: FileRowLike, side: 'unstaged' | 'staged'): FileDiffContext {
  if (side === 'unstaged') {
    return {
      oldRev: f.untracked ? '' : 'INDEX',
      newRev: f.status === 'D' ? '' : 'WORKTREE',
      spec: wipDiffSpec(f, side),
    };
  }
  return {
    ...(f.oldPath ? { oldPath: f.oldPath } : {}),
    oldRev: f.status === 'A' ? '' : 'HEAD',
    newRev: f.status === 'D' ? '' : 'INDEX',
    spec: wipDiffSpec(f, side),
  };
}

/** External-diff sides of a file in a commit (first parent, like the commit file list). */
export function commitDiffContext(f: FileRowLike, sha: string, parent: string | undefined): FileDiffContext {
  return {
    ...(f.oldPath ? { oldPath: f.oldPath } : {}),
    oldRev: f.status === 'A' || !parent ? '' : parent,
    newRev: f.status === 'D' ? '' : sha,
    spec: { kind: 'commit', sha, paths: f.oldPath ? [f.oldPath, f.path] : [f.path] },
  };
}

/** Repo-level "Open in…" (spec 12 §4.10): toolbar repo crumb ▾ and palette. */
export function repoOpenMenu(repoId: RepoId): MenuEntry[] {
  const mac = isMac();
  return [
    {
      label: mac ? 'Open in Finder' : 'Open in File Manager',
      shortcut: formatChord('alt+o', mac),
      onSelect: () => void showInFolder(repoRoot(repoId)),
    },
    {
      label: 'Open in Terminal (external)',
      shortcut: formatChord('alt+t', mac),
      onSelect: () => void openInTerminal(repoRoot(repoId)),
    },
    {
      label: 'Open in Editor',
      shortcut: formatChord('mod+shift+e', mac),
      onSelect: () => void openInEditor(repoRoot(repoId)),
    },
    'separator',
    { label: 'Copy repository path', onSelect: () => void copyFullPath(repoRoot(repoId)) },
  ];
}
