import type { RepoId } from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  EyeOff,
  FileWarning,
  GitMerge,
  GitPullRequestArrow,
  RefreshCw,
  Settings,
  Share2,
  Target,
  Users,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { ConflictReport, TeammateOverlap } from '../../../../shared/ipc/conflicts-contract';
import { fetchAll, merge, push, rebase } from '../../actions/git-actions';
import { Avatar } from '../../components/Avatar';
import { useContextMenu } from '../../components/ContextMenu';
import { confirm, prompt } from '../../components/Dialogs';
import { conflictsInvoke } from '../../conflicts/api';
import {
  branchName,
  formatRanges,
  groupOverlaps,
  overlapSummaryMarkdown,
  SEVEN_DAYS_MS,
} from '../../conflicts/helpers';
import { copyText } from '../../integrations/api';
import { showError } from '../../lib/ops';
import { IpcError } from '../../lib/api';
import { useRefs } from '../../repo/queries';
import { useToastStore } from '../../stores/toasts';
import s from './Conflicts.module.css';

/** What "Share my changes as Cloud Patch" hands to the Cloud Patches dialog. */
export interface ShareCloudPatchRequest {
  repoId: RepoId;
  /** Teammate user ids to add as collaborators. */
  collaboratorIds: string[];
  /** Overlapping files (the dialog may preselect them). */
  paths: string[];
}

function reportError(e: unknown): void {
  if (e instanceof IpcError) showError(e.error);
  else useToastStore.getState().push({ kind: 'error', title: e instanceof Error ? e.message : String(e) });
}

const openPrefs = (section: string): void => {
  window.dispatchEvent(new CustomEvent('kl:open-preferences', { detail: section }));
};

/** ConflictPopover (spec 14 §4.4): target section + teammates section + settings link. */
export function ConflictPopover({
  repoId,
  report,
  anchor,
  onClose,
  onShareCloudPatch,
}: {
  repoId: RepoId;
  report: ConflictReport;
  anchor: DOMRect;
  onClose(): void;
  onShareCloudPatch?: (req: ShareCloudPatchRequest) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      // Context menus / dialogs opened from the popover live outside it; the indicator toggles itself.
      if (
        ref.current &&
        !ref.current.contains(t) &&
        !t.closest?.('[role="menu"],dialog,[data-conflict-indicator]')
      )
        onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const left = Math.max(8, Math.min(anchor.left - 40, window.innerWidth - 408));
  const top = anchor.bottom + 6;

  return (
    <div ref={ref} className={s.popover} style={{ left, top }} role="dialog" aria-label="Conflict prevention">
      <TargetSection repoId={repoId} report={report} onClose={onClose} />
      {report.teammateOverlaps.length > 0 && (
        <TeammatesSection repoId={repoId} report={report} onShareCloudPatch={onShareCloudPatch} />
      )}
      <div className={s.footer}>
        <button type="button" className={s.link} onClick={() => openPrefs('Git')}>
          <Settings size={11} aria-hidden /> Conflict prevention settings
        </button>
        {report.ignoredCount > 0 && <span className={s.muted}>{report.ignoredCount} ignored</span>}
      </div>
    </div>
  );
}

function TargetSection({
  repoId,
  report,
  onClose,
}: {
  repoId: RepoId;
  report: ConflictReport;
  onClose(): void;
}) {
  const refs = useRefs(repoId);
  const [busy, setBusy] = useState(false);
  const { branch, target } = report;
  const count = report.targetConflicts.length;

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const changeTarget = async (): Promise<void> => {
    const names = (refs.data ?? [])
      .filter((r) => (r.type === 'local' || r.type === 'remote') && !r.symrefTarget && r.shortName !== branch)
      .map((r) => r.shortName);
    const res = await prompt({
      title: `Change target for ${branch}`,
      label: 'Target branch (leave empty for automatic)',
      placeholder: 'origin/main',
      initial: report.targetSource === 'config' ? target : '',
      okLabel: 'Set target',
      validate: (v) => (!v.trim() || names.includes(v.trim()) ? null : `No branch named "${v.trim()}"`),
    });
    if (!res) return;
    await run(() =>
      conflictsInvoke('conflicts:setTarget', { repoId, branch, target: res.value.trim() || null }),
    );
  };

  const headline =
    report.state === 'conflicts' ? (
      <>
        <b>{branch}</b> conflicts with <b>{target}</b> in {count} file{count === 1 ? '' : 's'}
      </>
    ) : report.state === 'ok' ? (
      <>
        No conflicts between <b>{branch}</b> and <b>{target}</b>
      </>
    ) : report.state === 'target-missing' ? (
      <>
        Target <b>{target}</b> not available — fetch to check for conflicts
      </>
    ) : report.state === 'ignored' ? (
      <>
        Not detecting conflicts with <b>{target}</b>
      </>
    ) : report.state === 'unsupported' ? (
      <>Conflict detection needs Git 2.38 or newer</>
    ) : report.state === 'error' ? (
      <>Conflict check failed: {report.error}</>
    ) : report.state === 'disabled' ? (
      <>Target branch detection is turned off</>
    ) : null;

  return (
    <section className={s.section} aria-label="Target branch">
      <h3 className={s.heading}>
        <Target size={12} aria-hidden /> Target branch
      </h3>
      <p className={s.headline}>{headline}</p>
      {report.wip && <span className={s.muted}>Includes uncommitted changes</span>}
      {count > 0 && (
        <ul className={s.files}>
          {report.targetConflicts.map((c) => (
            <ConflictFile key={c.path} repoId={repoId} report={report} path={c.path} />
          ))}
        </ul>
      )}
      <div className={s.actions}>
        {report.state === 'conflicts' && (
          <>
            <button
              type="button"
              className={`${s.btn} ${s.primary}`}
              disabled={busy}
              onClick={async () => {
                if (
                  await confirm(
                    `Rebase ${branch} onto ${target}?`,
                    'You will resolve the conflicts during the rebase.',
                    'Rebase',
                  )
                ) {
                  onClose();
                  rebase(repoId, target);
                }
              }}
            >
              <GitPullRequestArrow size={12} aria-hidden /> Rebase onto {target}
            </button>
            <button
              type="button"
              className={s.btn}
              disabled={busy}
              onClick={async () => {
                if (
                  await confirm(
                    `Merge ${target} into ${branch}?`,
                    'You will resolve the conflicts in the merge.',
                    'Merge',
                  )
                ) {
                  onClose();
                  merge(repoId, target);
                }
              }}
            >
              <GitMerge size={12} aria-hidden /> Merge {target} in
            </button>
          </>
        )}
        {report.state === 'target-missing' && (
          <button type="button" className={`${s.btn} ${s.primary}`} onClick={() => fetchAll(repoId)}>
            <RefreshCw size={12} aria-hidden /> Fetch
          </button>
        )}
        {report.state !== 'disabled' && (
          <button type="button" className={s.btn} disabled={busy} onClick={() => void changeTarget()}>
            <Target size={12} aria-hidden /> Change target…
          </button>
        )}
        {report.state === 'ignored' ? (
          <button
            type="button"
            className={s.btn}
            disabled={busy}
            onClick={() =>
              void run(() =>
                conflictsInvoke('conflicts:ignore', { repoId, scope: 'target', value: target, remove: true }),
              )
            }
          >
            Resume detecting
          </button>
        ) : (
          report.state !== 'disabled' && (
            <button
              type="button"
              className={s.btn}
              disabled={busy}
              onClick={() =>
                void run(() =>
                  conflictsInvoke('conflicts:ignore', { repoId, scope: 'target', value: target }),
                )
              }
            >
              <EyeOff size={12} aria-hidden /> Stop detecting for this target
            </button>
          )
        )}
        {(report.state === 'ok' || report.state === 'conflicts' || report.state === 'error') && (
          <button
            type="button"
            className={s.btn}
            disabled={busy}
            title="Check again now"
            onClick={() => void run(() => conflictsInvoke('conflicts:check', { repoId, force: true }))}
          >
            <RefreshCw size={12} aria-hidden /> Recheck
          </button>
        )}
      </div>
    </section>
  );
}

function ConflictFile({ repoId, report, path }: { repoId: RepoId; report: ConflictReport; path: string }) {
  const [open, setOpen] = useState(false);
  const hunks = useQuery({
    queryKey: ['conflictHunks', repoId, report.headSha, report.targetSha, report.wip, path],
    queryFn: () => conflictsInvoke('conflicts:hunks', { repoId, path }),
    enabled: open,
    staleTime: Infinity,
  });
  return (
    <li>
      <button
        type="button"
        className={s.fileRow}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={path}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <FileWarning size={12} />
        <span className={s.filePath}>{path}</span>
      </button>
      {open && (
        <ul className={s.hunks}>
          {hunks.isPending ? (
            <li>Loading…</li>
          ) : hunks.isError ? (
            <li>Could not read conflict details</li>
          ) : !hunks.data?.length ? (
            <li>Whole-file conflict (binary, rename or delete)</li>
          ) : (
            hunks.data.map((h, i) => (
              <li key={i}>
                mine {formatRanges([h.ours])} · {report.target} {formatRanges([h.theirs])}
              </li>
            ))
          )}
        </ul>
      )}
    </li>
  );
}

function TeammatesSection({
  repoId,
  report,
  onShareCloudPatch,
}: {
  repoId: RepoId;
  report: ConflictReport;
  onShareCloudPatch?: (req: ShareCloudPatchRequest) => void;
}) {
  const showMenu = useContextMenu((st) => st.show);
  const groups = groupOverlaps(report.teammateOverlaps);

  const ignore = (scope: 'file' | 'branch', value: string, until?: string): void => {
    conflictsInvoke('conflicts:ignore', { repoId, scope, value, ...(until ? { until } : {}) }).catch(
      reportError,
    );
  };
  const copy = (items: TeammateOverlap[]): void => {
    copyText(overlapSummaryMarkdown(report, items));
    useToastStore.getState().push({ kind: 'success', title: 'Overlap summary copied' });
  };

  return (
    <section className={s.section} aria-label="Teammates">
      <h3 className={s.heading}>
        <Users size={12} aria-hidden /> Teammates
      </h3>
      {groups.map(({ key, items }) => {
        const first = items[0]!;
        return (
          <div key={key} className={s.teammate}>
            <div className={s.who}>
              <Avatar name={first.user.name} email="" size={18} />
              <span>
                <b>{first.user.name}</b> is editing{' '}
                {items.length === 1 ? (
                  <span className={s.mono}>{first.path}</span>
                ) : (
                  `${items.length} of your files`
                )}{' '}
                on <span className={s.mono}>{branchName(first)}</span>
              </span>
            </div>
            {items.map((o) => (
              <dl key={o.pathHash} className={s.ranges} title={o.path}>
                <dt className={s.mono}>{o.path}</dt>
                <dd style={{ margin: 0 }} />
                <dt>{first.user.name}</dt>
                <dd style={{ margin: 0 }}>{formatRanges(o.theirRanges)}</dd>
                <dt>You</dt>
                <dd style={{ margin: 0 }}>{formatRanges(o.myRanges)}</dd>
              </dl>
            ))}
            <div className={s.actions}>
              <button
                type="button"
                className={s.btn}
                disabled={!onShareCloudPatch}
                title={
                  onShareCloudPatch
                    ? 'Share your changes to these files as a Cloud Patch'
                    : 'Cloud Patches are not available'
                }
                onClick={() =>
                  onShareCloudPatch?.({
                    repoId,
                    collaboratorIds: [first.user.id],
                    paths: items.map((o) => o.path),
                  })
                }
              >
                <Share2 size={12} aria-hidden /> Share my changes as Cloud Patch
              </button>
              <button type="button" className={s.btn} onClick={() => void push(repoId)}>
                <ArrowUpFromLine size={12} aria-hidden /> Push
              </button>
              <button type="button" className={s.btn} onClick={() => copy(items)}>
                <ClipboardCopy size={12} aria-hidden /> Copy summary
              </button>
              <button
                type="button"
                className={s.btn}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  const until = new Date(Date.now() + SEVEN_DAYS_MS).toISOString();
                  showMenu(r.left, r.bottom + 2, [
                    ...items.map((o) => ({
                      label: `Ignore ${o.path}`,
                      onSelect: () => ignore('file', o.path),
                    })),
                    {
                      label: `Ignore ${branchName(first)}`,
                      onSelect: () => ignore('branch', first.branchHash),
                    },
                    'separator',
                    {
                      label: 'Ignore for 7 days',
                      onSelect: () => items.forEach((o) => ignore('file', o.path, until)),
                    },
                  ]);
                }}
              >
                <EyeOff size={12} aria-hidden /> Ignore <ChevronDown size={11} aria-hidden />
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
