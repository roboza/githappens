import type { ConflictPrediction, Sha, TodoItem } from '../../types';
import type { GitService } from '../git-service';
import { assertSafeRev } from '../rev-set';
import { gitFail } from './shared';

const safeRev = (rev: string, _what: string): void => assertSafeRev(rev);

/** `git merge-base --is-ancestor` (spec 05 §6.5/§6.6, drag-and-drop matrix). */
export async function isAncestor(
  service: GitService,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  safeRev(ancestor, 'revision');
  safeRev(descendant, 'revision');
  const r = await service.runRead(['merge-base', '--is-ancestor', ancestor, descendant], {
    expectedExitCodes: [0, 1],
  });
  return r.exitCode === 0;
}

const PREDICT_CACHE_MAX = 256;
const predictCache = new Map<string, ConflictPrediction>();

/**
 * `conflict:predict` (spec 08 §6.9): `git merge-tree --write-tree --name-only` of the two revisions,
 * touching neither index nor worktree. `{supported:false}` on git < 2.38. Cached by (ours, theirs) sha.
 */
export async function predictConflicts(
  service: GitService,
  ours: string,
  theirs: string,
): Promise<ConflictPrediction> {
  safeRev(ours, 'revision');
  safeRev(theirs, 'revision');
  const features = (service['opts'] as { features?: { mergeTreeWriteTree?: boolean } }).features;
  if (features && features.mergeTreeWriteTree === false) return { supported: false, conflicts: [] };
  const [a, b] = await Promise.all([service.revParse(ours), service.revParse(theirs)]);
  if (!a || !b) throw gitFail(`Unknown revision: "${!a ? ours : theirs}".`);
  const key = `${service.repo.id}:${a}:${b}`;
  const hit = predictCache.get(key);
  if (hit) {
    predictCache.delete(key);
    predictCache.set(key, hit);
    return { ...hit, conflicts: [...hit.conflicts] };
  }
  const r = await service.runRead(
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', a, b],
    {
      expectedExitCodes: [0, 1, 128, 129],
      priority: 'background',
    },
  );
  let result: ConflictPrediction;
  if (r.exitCode === 0) result = { supported: true, conflicts: [] };
  else if (r.exitCode === 1) {
    const parts = r.stdout.split('\0');
    const conflicts: string[] = [];
    for (const p of parts.slice(1)) {
      if (!p) break;
      if (!conflicts.includes(p)) conflicts.push(p);
    }
    result = { supported: true, conflicts };
  } else if (/usage|unknown option|write-tree/i.test(r.stderr)) {
    result = { supported: false, conflicts: [] };
  } else {
    throw gitFail(r.stderr.trim() || 'git merge-tree failed.');
  }
  predictCache.set(key, result);
  while (predictCache.size > PREDICT_CACHE_MAX) predictCache.delete(predictCache.keys().next().value!);
  return { ...result, conflicts: [...result.conflicts] };
}

/**
 * `rebase:todoFor` (spec 05 §6.8): commits after `upstream` up to `branch` (default HEAD), oldest first, as
 * `pick` items. Throws when the range contains merge commits.
 */
export async function rebaseTodoFor(
  service: GitService,
  upstream: string,
  branch = 'HEAD',
): Promise<TodoItem[]> {
  safeRev(upstream, 'upstream');
  safeRev(branch, 'branch');
  const r = await service.runRead([
    'log',
    '--reverse',
    '--topo-order',
    '--format=%H%x00%P%x00%s',
    `${upstream}..${branch}`,
    '--',
  ]);
  const items: TodoItem[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [sha, parents, summary] = line.split('\0');
    if ((parents ?? '').trim().split(/\s+/).filter(Boolean).length > 1) {
      throw gitFail('The range contains merge commits; interactive rebase cannot rewrite it.', {
        merge: sha!,
      });
    }
    items.push({ sha: sha!, action: 'pick', summary: summary ?? '' });
  }
  return items;
}

/**
 * Sort commits oldest → newest in topological order (spec 05 §6.9: cherry-pick re-sorts with
 * `rev-list --topo-order --reverse`). Unrelated commits keep commit-date order.
 */
export async function topoSort(service: GitService, shas: Sha[]): Promise<Sha[]> {
  const list = [...new Set(shas)];
  if (list.length < 2) return list;
  // commit-date order (oldest first) as the base / tie-breaker
  const dated = await service.runRead(['show', '-s', '--no-walk=unsorted', '--format=%H %ct', ...list, '--']);
  const time = new Map<Sha, number>();
  for (const l of dated.stdout.split(/\r?\n/)) {
    const [s, t] = l.trim().split(' ');
    if (s && t) time.set(s, Number(t));
  }
  const byDate = [...list].sort((a, b) => (time.get(a) ?? 0) - (time.get(b) ?? 0));
  // topological order of the selection: walk only the part of history between the commits
  const mb = await service.runRead(['merge-base', '--octopus', ...list], { expectedExitCodes: [0, 1] });
  const base = mb.exitCode === 0 ? mb.stdout.trim().split(/\s+/)[0] : undefined;
  const args = ['rev-list', '--topo-order', '--reverse', ...list];
  if (base) args.push('--not', `${base}^@`);
  const walk = await service.runRead([...args, '--'], { expectedExitCodes: [0, 128] });
  if (walk.exitCode !== 0) return byDate;
  const want = new Set(list);
  const ordered = walk.stdout.split(/\r?\n/).filter((s) => want.has(s));
  if (ordered.length !== list.length) return byDate;
  return ordered;
}
