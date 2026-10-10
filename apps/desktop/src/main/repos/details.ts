import fs from 'node:fs';
import path from 'node:path';

import { stripUrlCredentials, type GitProcessRunner } from '@githappens/git';

import type { RepoDetails } from '../../shared/ipc/repos2-contract';

const README_MAX = 256 * 1024;
const README_RE = /^readme(\.(md|markdown|mdown|txt|rst))?$/i;

/** Preferred README among the candidates: README.md first, then other markdown, then plain. */
export function pickReadme(names: string[]): string | undefined {
  const c = names.filter((n) => README_RE.test(n));
  const rank = (n: string): number =>
    /\.md$/i.test(n)
      ? n === 'README.md'
        ? 0
        : 1
      : /\.(markdown|mdown)$/i.test(n)
        ? 2
        : /\./.test(n)
          ? 4
          : 3;
  return c.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
}

/** `git count-objects -v` → bytes (loose `size` + `size-pack`, both KiB). */
export function parseCountObjects(out: string): number | undefined {
  const kib = (k: string): number => Number(new RegExp(`^${k}: (\\d+)$`, 'm').exec(out)?.[1] ?? NaN);
  const total = (kib('size') || 0) + (kib('size-pack') || 0);
  return Number.isFinite(total) && /size-pack:/.test(out) ? total * 1024 : undefined;
}

/**
 * Details pane of Repository Management (spec 03 `repos:details`): branch, remotes, last commit, size and
 * the README (worktree file, or `HEAD:<file>` for bare repos). Never throws for partial data.
 */
export async function repoDetails(runner: GitProcessRunner, repoPath: string): Promise<RepoDetails> {
  const cwd = path.resolve(repoPath);
  if (!fs.existsSync(cwd)) throw new Error('The folder does not exist.');
  const read = (args: string[], codes = [0, 1, 128]) =>
    runner.run({ cwd, args, readOnly: true, expectedExitCodes: codes, timeoutMs: 20_000 });

  const bareRes = await read(['rev-parse', '--is-bare-repository']);
  if (bareRes.exitCode !== 0) throw new Error('This folder is not a Git repository.');
  const isBare = String(bareRes.stdout).trim() === 'true';

  const [sym, remotesRes, logRes, countRes] = await Promise.all([
    read(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    read(['remote', '-v']),
    read(['log', '-1', '--format=%H%x00%s%x00%an%x00%ct', 'HEAD']),
    read(['count-objects', '-v']),
  ]);
  let branch = sym.exitCode === 0 ? String(sym.stdout).trim() : undefined;
  if (!branch) {
    const short = await read(['rev-parse', '--short', 'HEAD']);
    branch = short.exitCode === 0 ? `(detached ${String(short.stdout).trim()})` : undefined;
  }

  const remotes: RepoDetails['remotes'] = [];
  for (const line of String(remotesRes.stdout).split(/\r?\n/)) {
    const m = /^(\S+)\s+(.+?)\s+\(fetch\)$/.exec(line);
    if (m && !remotes.some((r) => r.name === m[1]))
      remotes.push({ name: m[1]!, url: stripUrlCredentials(m[2]!).url });
  }

  let lastCommit: RepoDetails['lastCommit'];
  if (logRes.exitCode === 0 && String(logRes.stdout).trim()) {
    const [sha, subject, author, ct] = String(logRes.stdout).trim().split('\0');
    lastCommit = { sha: sha!, subject: subject ?? '', author: author ?? '', date: Number(ct) || 0 };
  }

  let readme: RepoDetails['readme'];
  try {
    if (isBare) {
      const ls = await read(['ls-tree', '--name-only', 'HEAD']);
      const name = ls.exitCode === 0 ? pickReadme(String(ls.stdout).split(/\r?\n/)) : undefined;
      if (name) {
        const r = await runner.run({
          cwd,
          args: ['show', `HEAD:${name}`],
          readOnly: true,
          encoding: 'buffer',
        });
        const buf = r.stdout;
        readme = {
          name,
          markdown: buf.subarray(0, README_MAX).toString('utf8'),
          truncated: buf.length > README_MAX,
        };
      }
    } else {
      const name = pickReadme(await fs.promises.readdir(cwd));
      if (name) {
        const fh = await fs.promises.open(path.join(cwd, name), 'r');
        try {
          const buf = Buffer.alloc(README_MAX + 1);
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          readme = {
            name,
            markdown: buf.subarray(0, Math.min(bytesRead, README_MAX)).toString('utf8'),
            truncated: bytesRead > README_MAX,
          };
        } finally {
          await fh.close();
        }
      }
    }
  } catch {
    /* README is optional */
  }

  const sizeBytes = countRes.exitCode === 0 ? parseCountObjects(String(countRes.stdout)) : undefined;
  return {
    path: cwd,
    isBare,
    ...(branch ? { branch } : {}),
    remotes,
    ...(lastCommit ? { lastCommit } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(readme ? { readme } : {}),
  };
}
