import type { BranchCleanupCandidate, BranchCleanupScan, Sha } from '../types';
import type { GitService } from './git-service';

/**
 * "Clean up branches" scan (spec 05 §6.13): local branches whose work is already in the base branch
 * (ancestry, rebase or squash merge) or whose upstream was deleted. Read-only; the delete goes through
 * the journaled `branch.delete` op with `expectedSha` so a branch that moved after the scan is skipped.
 */

/** Never offered, whatever their state. */
const ALWAYS_PROTECTED = new Set(['main', 'master', 'develop', 'trunk']);
/** Base commits whose patch-ids are compared against (squash/rebase detection window). */
const BASE_WINDOW = 1000;
const CONCURRENCY = 4;
const LOG_P = ['--no-color', '--no-ext-diff', '--no-textconv', '-p', '--no-merges', '--format=commit %H'];

const LOCAL_FORMAT =
  [
    '%(refname)',
    '%(objectname)',
    '%(upstream)',
    '%(HEAD)',
    '%(worktreepath)',
    '%(committerdate:unix)',
    '%(authorname)',
    '%(contents:subject)',
  ].join('%00') + '%1e';

interface LocalBranch {
  name: string;
  sha: Sha;
  upstream: string; // full ref or ''
  isHead: boolean;
  worktreePath: string;
  committerDate: number;
  authorName: string;
  subject: string;
}

export function parseLocalBranches(text: string): LocalBranch[] {
  const out: LocalBranch[] = [];
  for (const raw of text.split('\x1e')) {
    const f = raw.replace(/^\r?\n/, '').split('\0');
    if (f.length !== 8 || !f[0]?.startsWith('refs/heads/')) continue;
    out.push({
      name: f[0].slice('refs/heads/'.length),
      sha: f[1]!,
      upstream: f[2]!,
      isHead: f[3] === '*',
      worktreePath: f[4]!,
      committerDate: Number(f[5]) || 0,
      authorName: f[6]!,
      subject: f[7]!,
    });
  }
  return out;
}

/** First column of `git patch-id --stable` output. */
export function parsePatchIds(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const id = line.split(' ')[0];
    if (id && /^[0-9a-f]+$/.test(id)) ids.push(id);
  }
  return ids;
}

const shortRemoteRef = (ref: string): string => ref.replace(/^refs\/(remotes|heads)\//, '');

/** `refs/remotes/<r>/HEAD`, then `<r>/main|master`, then local main/master (origin first). */
async function resolveBase(svc: GitService): Promise<{ ref: string; sha: Sha } | null> {
  const remotes = (await svc.runRead(['remote'])).stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .sort((a, b) => Number(b === 'origin') - Number(a === 'origin'));
  const verify = async (ref: string): Promise<Sha | null> => {
    const r = await svc.runRead(['rev-parse', '-q', '--verify', `${ref}^{commit}`], {
      expectedExitCodes: [0, 1, 128],
    });
    return r.exitCode === 0 ? r.stdout.trim() || null : null;
  };
  for (const remote of remotes) {
    const r = await svc.runRead(['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`], {
      expectedExitCodes: [0, 1, 128],
    });
    const target = r.exitCode === 0 ? r.stdout.trim() : '';
    const sha = target ? await verify(target) : null;
    if (sha) return { ref: target, sha };
  }
  const fallbacks = [
    ...remotes.flatMap((r) => [`refs/remotes/${r}/main`, `refs/remotes/${r}/master`]),
    'refs/heads/main',
    'refs/heads/master',
  ];
  for (const ref of fallbacks) {
    const sha = await verify(ref);
    if (sha) return { ref, sha };
  }
  return null;
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < items.length) await fn(items[i++]!);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

export async function branchCleanupScan(svc: GitService): Promise<BranchCleanupScan> {
  const base = await resolveBase(svc);
  const [localOut, allRefsOut] = await Promise.all([
    svc.runRead(['for-each-ref', `--format=${LOCAL_FORMAT}`, 'refs/heads']),
    svc.runRead(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']),
  ]);
  const locals = parseLocalBranches(localOut.stdout);
  const existing = new Set(allRefsOut.stdout.split(/\r?\n/).filter(Boolean));

  const baseTwin = base?.ref.startsWith('refs/remotes/')
    ? base.ref.split('/').slice(3).join('/')
    : base?.ref.replace(/^refs\/heads\//, '');
  const protectedBranches: string[] = [];
  const open: LocalBranch[] = [];
  for (const b of locals) {
    if (b.isHead || b.worktreePath || ALWAYS_PROTECTED.has(b.name) || b.name === baseTwin)
      protectedBranches.push(b.name);
    else open.push(b);
  }
  if (!base) return { base: null, baseSha: null, candidates: [], protectedBranches };

  const merged = new Set(
    (await svc.runRead(['for-each-ref', `--merged=${base.sha}`, '--format=%(refname)', 'refs/heads'])).stdout
      .split(/\r?\n/)
      .filter(Boolean),
  );

  const candidates: BranchCleanupCandidate[] = [];
  const unmerged: LocalBranch[] = [];
  const candidate = (
    b: LocalBranch,
    reason: BranchCleanupCandidate['reason'],
    aheadOfBase: number,
  ): BranchCleanupCandidate => ({
    name: b.name,
    sha: b.sha,
    reason,
    ...(b.upstream ? { upstream: shortRemoteRef(b.upstream) } : {}),
    upstreamGone: !!b.upstream && !existing.has(b.upstream),
    aheadOfBase,
    committerDate: b.committerDate,
    authorName: b.authorName,
    subject: b.subject,
  });
  for (const b of open) {
    const gone = !!b.upstream && !existing.has(b.upstream);
    if (merged.has(`refs/heads/${b.name}`)) {
      // At the base tip with a live (or no) upstream: most likely a branch just created, not one merged.
      if (b.sha === base.sha && !gone) continue;
      candidates.push(candidate(b, 'merged', 0));
    } else {
      unmerged.push(b);
    }
  }

  // Squash / rebase detection by patch-id against the recent base history (computed once, lazily).
  let basePatchIds: Promise<Set<string>> | null = null;
  const loadBasePatchIds = (): Promise<Set<string>> =>
    (basePatchIds ??= (async () => {
      try {
        const log = await svc.runRead(['log', ...LOG_P, `--max-count=${BASE_WINDOW}`, base.sha], {
          maxBuffer: 256 * 1024 * 1024,
          timeoutMs: 120_000,
        });
        const ids = await svc.runRead(['patch-id', '--stable'], {
          stdin: log.stdout,
          maxBuffer: 16 * 1024 * 1024,
        });
        return new Set(parsePatchIds(ids.stdout));
      } catch {
        return new Set<string>(); // huge history: fall back to "upstream gone" only
      }
    })());

  const found = new Map<string, BranchCleanupCandidate>();
  await pool(unmerged, CONCURRENCY, async (b) => {
    const gone = !!b.upstream && !existing.has(b.upstream);
    const mbOut = await svc.runRead(['merge-base', base.sha, b.sha], { expectedExitCodes: [0, 1] });
    const mb = mbOut.exitCode === 0 ? mbOut.stdout.trim() : '';
    const ahead = Number(
      (await svc.runRead(['rev-list', '--count', b.sha, `^${base.sha}`])).stdout.trim() || '0',
    );
    if (mb) {
      const baseIds = await loadBasePatchIds();
      if (baseIds.size) {
        const own = await svc.runRead(['log', ...LOG_P, b.sha, `^${mb}`], { maxBuffer: 64 * 1024 * 1024 });
        const ownIds = parsePatchIds(
          (await svc.runRead(['patch-id', '--stable'], { stdin: own.stdout })).stdout,
        );
        if (ownIds.length && ownIds.every((id) => baseIds.has(id))) {
          found.set(b.name, candidate(b, 'rebase-merged', ahead));
          return;
        }
        const diff = await svc.runRead(['diff', '--no-color', '--no-ext-diff', '--no-textconv', mb, b.sha], {
          maxBuffer: 64 * 1024 * 1024,
        });
        const [squashId] = parsePatchIds(
          (await svc.runRead(['patch-id', '--stable'], { stdin: diff.stdout })).stdout,
        );
        if (squashId && baseIds.has(squashId)) {
          found.set(b.name, candidate(b, 'squash-merged', ahead));
          return;
        }
      }
    }
    if (gone) found.set(b.name, candidate(b, 'upstream-gone', ahead));
  });
  candidates.push(...found.values());
  candidates.sort((a, b) => a.name.localeCompare(b.name));

  return { base: shortRemoteRef(base.ref), baseSha: base.sha, candidates, protectedBranches };
}
