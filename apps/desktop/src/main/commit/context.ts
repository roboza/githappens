import fs from 'node:fs';

import { batchPathspec, normalizeGitPath, type GitService } from '@githappens/git';

import type { CommitContext, EolIssue } from '../../shared/ipc/commit-contract';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Hooks that run during `git commit` (spec 06 §4.6). */
export const COMMIT_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit'] as const;

/** A hook file counts when it exists and (outside Windows) is executable; `.sample` files never do. */
export function isRunnableHook(
  file: string,
  platform: NodeJS.Platform = process.platform,
  stat: (p: string) => fs.Stats | null = (p) => {
    try {
      return fs.statSync(p);
    } catch {
      return null;
    }
  },
): boolean {
  if (file.endsWith('.sample')) return false;
  const st = stat(file);
  if (!st?.isFile()) return false;
  return platform === 'win32' || (st.mode & 0o111) !== 0;
}

async function configBool(svc: GitService, key: string): Promise<boolean> {
  const r = await svc.runRead(['config', '--type=bool', '--get', key], { expectedExitCodes: [0, 1, 128] });
  return r.exitCode === 0 && String(r.stdout).trim() === 'true';
}

async function configValue(svc: GitService, key: string): Promise<string | null> {
  const r = await svc.runRead(['config', '--get', key], { expectedExitCodes: [0, 1] });
  const v = r.exitCode === 0 ? String(r.stdout).trim() : '';
  return v || null;
}

/** Executable commit hooks (respects `core.hooksPath` via `rev-parse --git-path`). */
export async function commitHooks(svc: GitService): Promise<string[]> {
  const out: string[] = [];
  for (const name of COMMIT_HOOKS) {
    const r = await svc.runRead(['rev-parse', '--path-format=absolute', '--git-path', `hooks/${name}`], {
      expectedExitCodes: [0, 128],
    });
    const p = r.exitCode === 0 ? normalizeGitPath(String(r.stdout)) : '';
    if (p && isRunnableHook(p)) out.push(name);
  }
  return out;
}

/** Composer context: hooks, signing defaults, "HEAD already pushed" (spec 06 §4.5). */
export async function commitContext(svc: GitService): Promise<CommitContext> {
  const head = await svc.revParse('HEAD');
  const [hooks, signByDefault, signingKey, format] = await Promise.all([
    commitHooks(svc),
    configBool(svc, 'commit.gpgsign'),
    configValue(svc, 'user.signingkey'),
    configValue(svc, 'gpg.format'),
  ]);
  let headPushed: CommitContext['headPushed'] = null;
  if (head) {
    const up = await svc.runRead(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      expectedExitCodes: [0, 128],
    });
    const upstream = up.exitCode === 0 ? String(up.stdout).trim() : '';
    if (upstream) {
      const anc = await svc.runRead(['merge-base', '--is-ancestor', 'HEAD', '@{u}'], {
        expectedExitCodes: [0, 1, 128],
      });
      if (anc.exitCode === 0) headPushed = { upstream };
    }
  }
  return {
    hooks,
    signByDefault,
    signingConfigured: signByDefault || !!signingKey || !!format,
    headPushed,
    unborn: !head,
  };
}

/** Parse `git ls-files --eol -z` records: `i/<eol> w/<eol> attr/<attr>\t<path>`. */
export function parseLsFilesEol(stdout: string): { path: string; index: string; worktree: string }[] {
  const out: { path: string; index: string; worktree: string }[] = [];
  for (const rec of stdout.split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const info = rec.slice(0, tab);
    const i = /i\/(\S*)/.exec(info)?.[1] ?? '';
    const w = /w\/(\S*)/.exec(info)?.[1] ?? '';
    out.push({ path: rec.slice(tab + 1), index: i, worktree: w });
  }
  return out;
}

/** Staged text files whose index content has CRLF or mixed line endings (spec 06 §4.8). */
export async function stagedEolIssues(svc: GitService): Promise<EolIssue[]> {
  const head = await svc.revParse('HEAD');
  const names = await svc.runRead(
    ['diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=AMT', head ?? EMPTY_TREE, '--'],
    { expectedExitCodes: [0, 128] },
  );
  const paths = String(names.stdout).split('\0').filter(Boolean);
  if (!paths.length) return [];
  const out: EolIssue[] = [];
  for (const b of batchPathspec(['ls-files', '--eol', '-z'], paths)) {
    const r = await svc.runRead(b.args, { env: b.env });
    for (const e of parseLsFilesEol(String(r.stdout))) {
      if (e.index === 'crlf' || e.index === 'mixed') out.push({ path: e.path, eol: e.index });
    }
  }
  return out;
}
