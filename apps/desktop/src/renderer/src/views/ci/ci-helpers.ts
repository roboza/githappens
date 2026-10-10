import type { CheckStatus, ProviderKind } from '@githappens/providers/types';

import type { CiRun, ResolvedRemote } from '../../../../shared/ipc/integrations-contract';
import type { Tone } from '../../integrations/helpers';

/** Pure helpers for the CI section (spec 10 §4.8). */

/** Section title: GitHub calls them Actions, everyone else pipelines. */
export function ciSectionTitle(kind: ProviderKind | string | null | undefined): string {
  return kind === 'github' ? 'ACTIONS' : 'PIPELINES';
}

/** The provider remote whose CI is shown: `origin` first, else the first remote with a repo ref. */
export function pickCiRemote<T extends Pick<ResolvedRemote, 'remote' | 'ref' | 'integrationKey'>>(
  remotes: readonly T[],
): T | undefined {
  const usable = remotes.filter((r) => !!r.ref);
  const connected = usable.filter((r) => !!r.integrationKey);
  const pool = connected.length ? connected : usable;
  return pool.find((r) => r.remote === 'origin') ?? pool[0];
}

export const isRunActive = (s: CheckStatus): boolean => s === 'queued' || s === 'in_progress';
export const isRunFailed = (s: CheckStatus): boolean => s === 'failure' || s === 'timed_out';

/** Which context-menu actions apply to a run. */
export function runActions(r: Pick<CiRun, 'status' | 'canRerun' | 'detailsUrl'>): {
  open: boolean;
  rerun: boolean;
  rerunFailed: boolean;
  cancel: boolean;
} {
  const active = isRunActive(r.status);
  return {
    open: !!r.detailsUrl,
    rerun: r.canRerun && !active,
    rerunFailed: r.canRerun && isRunFailed(r.status),
    cancel: active,
  };
}

export interface RunGroup {
  group: string;
  runs: CiRun[];
}

/** Group runs by workflow (`group`, falling back to the run name), in first-seen order. */
export function groupRuns(runs: readonly CiRun[]): RunGroup[] {
  const map = new Map<string, CiRun[]>();
  for (const r of runs) {
    const g = r.group?.trim() || r.name || 'Other';
    const list = map.get(g);
    if (list) list.push(r);
    else map.set(g, [r]);
  }
  return [...map].map(([group, list]) => ({ group, runs: list }));
}

/** Remove duplicate runs across pages (a run can move between pages while polling). */
export function dedupeRuns(runs: readonly CiRun[]): CiRun[] {
  const seen = new Set<string>();
  const out: CiRun[] = [];
  for (const r of runs) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

export function ciStatusTone(s: CheckStatus): Tone {
  switch (s) {
    case 'success':
      return 'green';
    case 'failure':
    case 'timed_out':
      return 'red';
    case 'queued':
    case 'in_progress':
    case 'action_required':
      return 'yellow';
    default:
      return 'grey';
  }
}

export const CI_STATUS_LABEL: Record<CheckStatus, string> = {
  queued: 'Queued',
  in_progress: 'In progress',
  success: 'Succeeded',
  failure: 'Failed',
  neutral: 'Neutral',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  timed_out: 'Timed out',
  action_required: 'Action required',
};

/** Compact age: `now`, `5m`, `3h`, `2d`, `6w`, `1y`. */
export function shortAge(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  if (s < 365 * 86_400) return `${Math.floor(s / (7 * 86_400))}w`;
  return `${Math.floor(s / (365 * 86_400))}y`;
}

/** Duration `1m 05s` between start and completion (or now while running). */
export function runDuration(r: Pick<CiRun, 'startedAt' | 'completedAt'>, now = Date.now()): string {
  if (!r.startedAt) return '';
  const start = Date.parse(r.startedAt);
  const end = r.completedAt ? Date.parse(r.completedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return '';
  const secs = Math.max(0, Math.round((end - start) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Multi-line row tooltip. */
export function runTooltip(r: CiRun, now = Date.now()): string {
  const dur = runDuration(r, now);
  return [
    `${r.group ? `${r.group} · ` : ''}${r.name}${r.runNumber !== undefined ? ` #${r.runNumber}` : ''}`,
    `${CI_STATUS_LABEL[r.status]}${dur ? ` in ${dur}` : ''}`,
    r.branch ? `Branch: ${r.branch}` : '',
    r.event ? `Event: ${r.event}` : '',
    r.actor ? `By ${r.actor.login}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
