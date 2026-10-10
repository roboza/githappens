import type { RepoId } from '@githappens/git/types';
import { ChevronDown, ChevronRight, Ellipsis, GitBranch, Plus, TriangleAlert, Workflow } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type {
  GitflowBranches,
  GitflowBranchKind,
  GitflowConfig,
  GitflowFinishKind,
  GitflowPendingFinish,
} from '../../../../shared/ipc/gitflow-contract';
import { useContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { confirm } from '../../components/Dialogs';
import { GITFLOW_INIT_EVENT, GITFLOW_START_EVENT, useGitflow } from '../../gitflow/api';
import { quiet, runOp } from '../../lib/ops';
import { useRefs, useRemotes } from '../../repo/queries';
import { useIsRunning } from '../../stores/ops';
import leftStyles from '../left/LeftPanel.module.css';
import styles from './GitFlow.module.css';
import { GitFlowFinishDialog, GitFlowInitDialog } from './GitFlowDialogs';
import {
  defaultSupportBase,
  FLOW_KINDS,
  flowName,
  GROUP_TITLE,
  isFinishable,
  KIND_TITLE,
  pickRemote,
  validateFlowName,
} from './helpers';
import { confirmResetGitflow } from './reset';

const PAUSED_OPS = ['gitflow.continue', 'gitflow.abort'] as const;

const NO_BRANCHES: GitflowBranches = { feature: [], bugfix: [], release: [], hotfix: [], support: [] };

/**
 * Left-panel GITFLOW section (spec 12 §4.9): "Initialize Git Flow" when not configured; otherwise a green
 * "+" menu (Start Feature / Bugfix / Release / Hotfix / Support with an inline name input; support also
 * asks for its base tag), the flow branches grouped by type with Finish / Publish / Delete (support
 * branches are long-lived: no Finish), and a notice with Continue / Abort while a finish is paused. The
 * header ⋯ menu has the settings dialog and "Reset Git Flow configuration…".
 */
export function GitFlowSection({ repoId }: { repoId: RepoId }) {
  const q = useGitflow(repoId);
  const showMenu = useContextMenu((s) => s.show);
  const remote = pickRemote((useRemotes(repoId).data ?? []).map((r) => r.name));
  const [open, setOpen] = useState(true);
  const [initOpen, setInitOpen] = useState(false);
  const [starting, setStarting] = useState<GitflowBranchKind | null>(null);
  const [finishing, setFinishing] = useState<{ kind: GitflowFinishKind; branch: string } | null>(null);
  const cfg = q.data?.config ?? null;
  const branches = q.data?.branches ?? NO_BRANCHES;
  const pending = q.data?.pendingFinish ?? null;
  const count = FLOW_KINDS.reduce((n, k) => n + branches[k].length, 0);

  // command palette hooks (see gitflowCommands)
  useEffect(() => {
    const onInit = (e: Event): void => {
      if ((e as CustomEvent<RepoId>).detail === repoId) setInitOpen(true);
    };
    const onStart = (e: Event): void => {
      const d = (e as CustomEvent<{ repoId: RepoId; kind: GitflowBranchKind }>).detail;
      if (d.repoId !== repoId) return;
      setOpen(true);
      setStarting(d.kind);
    };
    window.addEventListener(GITFLOW_INIT_EVENT, onInit);
    window.addEventListener(GITFLOW_START_EVENT, onStart);
    return () => {
      window.removeEventListener(GITFLOW_INIT_EVENT, onInit);
      window.removeEventListener(GITFLOW_START_EVENT, onStart);
    };
  }, [repoId]);

  const menuAt = (el: HTMLElement, items: MenuEntry[]): void => {
    const r = el.getBoundingClientRect();
    showMenu(r.left, r.bottom, items);
  };

  const startMenu = (el: HTMLElement): void =>
    menuAt(
      el,
      FLOW_KINDS.map((k) => ({
        label: `Start ${KIND_TITLE[k]}`,
        onSelect: () => {
          setOpen(true);
          setStarting(k);
        },
      })),
    );

  const headerMenu = (el: HTMLElement): void =>
    menuAt(el, [
      { label: cfg ? 'Git Flow settings…' : 'Initialize Git Flow…', onSelect: () => setInitOpen(true) },
      ...(cfg
        ? ([
            'separator',
            {
              label: 'Reset Git Flow configuration…',
              danger: true,
              disabled: !!pending,
              title: pending ? 'Continue or abort the paused finish first' : undefined,
              onSelect: () => void confirmResetGitflow(repoId),
            },
          ] satisfies MenuEntry[])
        : []),
    ]);

  return (
    <section className={leftStyles.section}>
      <div className={leftStyles.sectionHeaderRow}>
        <button
          type="button"
          className={leftStyles.sectionHeader}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Workflow size={14} />
          <span className={leftStyles.sectionTitle}>Gitflow</span>
          {cfg && <span className={leftStyles.count}>{count}</span>}
        </button>
        {cfg && (
          <HeaderButton label="Start a Git Flow branch" className={styles.addFlow} onClick={startMenu}>
            <Plus size={14} />
          </HeaderButton>
        )}
        <HeaderButton label="Git Flow options" onClick={headerMenu}>
          <Ellipsis size={14} />
        </HeaderButton>
      </div>
      {open && (
        <div role="tree" aria-label="Gitflow">
          {pending && <PausedNotice repoId={repoId} pending={pending} />}
          {!cfg ? (
            q.isPending ? null : (
              <p className={leftStyles.empty}>
                <button type="button" className={styles.link} onClick={() => setInitOpen(true)}>
                  Initialize Git Flow
                </button>
              </p>
            )
          ) : (
            <>
              {starting && (
                <StartInput
                  repoId={repoId}
                  kind={starting}
                  prefix={cfg[starting]}
                  existing={branches[starting]}
                  onDone={() => setStarting(null)}
                />
              )}
              {FLOW_KINDS.filter((k) => branches[k].length > 0).map((k) => (
                <div key={k} role="group" aria-label={GROUP_TITLE[k]}>
                  <div className={`${leftStyles.row} ${styles.group}`}>{GROUP_TITLE[k]}</div>
                  {branches[k].map((b) => (
                    <FlowRow
                      key={b}
                      repoId={repoId}
                      cfg={cfg}
                      kind={k}
                      branch={b}
                      remote={remote}
                      onFinish={() => isFinishable(k) && setFinishing({ kind: k, branch: b })}
                    />
                  ))}
                </div>
              ))}
              {count === 0 && !starting && <p className={leftStyles.empty}>No flow branches</p>}
            </>
          )}
        </div>
      )}
      {initOpen && <GitFlowInitDialog repoId={repoId} config={cfg} onClose={() => setInitOpen(false)} />}
      {finishing && cfg && (
        <GitFlowFinishDialog
          repoId={repoId}
          config={cfg}
          kind={finishing.kind}
          branch={finishing.branch}
          releases={branches.release}
          onClose={() => setFinishing(null)}
        />
      )}
    </section>
  );
}

function HeaderButton({
  label,
  className,
  onClick,
  children,
}: {
  label: string;
  className?: string;
  onClick(el: HTMLElement): void;
  children: ReactNode;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={label}
      title={label}
      className={`${leftStyles.headerAdd} ${className ?? ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e.currentTarget);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onClick(e.currentTarget);
        }
      }}
    >
      {children}
    </span>
  );
}

/** Inline name input with the prefix as a non-editable chip (spec 12 §4.9). */
function StartInput({
  repoId,
  kind,
  prefix,
  existing,
  onDone,
}: {
  repoId: RepoId;
  kind: GitflowBranchKind;
  prefix: string;
  existing: string[];
  onDone(): void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), [kind]);
  // support branches start from a base ref (`git flow support start <name> <base>`): the newest tag by default
  const needsBase = kind === 'support';
  const refs = useRefs(repoId).data;
  const tags = useMemo(() => (refs ?? []).filter((r) => r.type === 'tag'), [refs]);
  const [baseEdited, setBaseEdited] = useState<string | null>(null);
  const base = baseEdited ?? defaultSupportBase(tags);

  const submit = async (): Promise<void> => {
    const name = value.trim();
    const err =
      validateFlowName(name) ??
      (existing.includes(`${prefix}${name}`) ? 'That branch already exists.' : null) ??
      (needsBase && !base.trim() ? 'Choose the tag (or commit) the support branch starts from.' : null);
    if (err) {
      setError(err);
      return;
    }
    setBusy(true);
    try {
      const r = await runOp(
        repoId,
        { type: 'gitflow.start', kind, name, ...(needsBase ? { base: base.trim() } : {}) },
        { successToast: (x) => x.summary ?? `Started ${prefix}${name}` },
      );
      if (r) onDone();
    } catch {
      /* reported by runOp */
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className={styles.startRow}>
        <GitBranch size={13} aria-hidden />
        <span className={styles.chip}>{prefix}</span>
        <input
          ref={ref}
          aria-label={`New ${kind} name`}
          placeholder={`${kind} name`}
          value={value}
          disabled={busy}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
            if (e.key === 'Escape') onDone();
          }}
          onBlur={(e) => {
            // moving focus to the base input is not "leaving" the start row
            if (needsBase && e.relatedTarget instanceof HTMLElement && e.relatedTarget.dataset.flowBase)
              return;
            if (!value.trim() && !busy) onDone();
          }}
        />
      </div>
      {needsBase && (
        <div className={styles.startRow}>
          <span className={styles.chip}>from</span>
          <input
            data-flow-base="1"
            aria-label="Support branch base (tag or commit)"
            placeholder="tag, e.g. v1.0"
            value={base}
            disabled={busy}
            list={`gitflow-tags-${repoId}`}
            onChange={(e) => {
              setBaseEdited(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
              if (e.key === 'Escape') onDone();
            }}
          />
          <datalist id={`gitflow-tags-${repoId}`}>
            {tags.map((t) => (
              <option key={t.fullName} value={t.shortName} />
            ))}
          </datalist>
        </div>
      )}
      {error && (
        <p className={styles.startError} role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function FlowRow({
  repoId,
  cfg,
  kind,
  branch,
  remote,
  onFinish,
}: {
  repoId: RepoId;
  cfg: GitflowConfig;
  kind: GitflowBranchKind;
  branch: string;
  remote: string | null;
  onFinish(): void;
}) {
  const showMenu = useContextMenu((s) => s.show);
  const name = flowName(branch, cfg[kind]);
  return (
    <div
      role="treeitem"
      tabIndex={0}
      className={leftStyles.row}
      style={{ paddingLeft: 25 }}
      title={branch}
      onDoubleClick={() =>
        quiet(
          runOp(repoId, {
            type: 'checkout.run',
            target: { kind: 'branch', name: branch },
            dirtyStrategy: 'carry',
          }),
        )
      }
      onKeyDown={(e) => e.key === 'Enter' && onFinish()}
      onContextMenu={(e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          isFinishable(kind)
            ? { label: `Finish ${KIND_TITLE[kind]} ${name}…`, onSelect: onFinish }
            : {
                label: `Finish ${KIND_TITLE[kind]} ${name}…`,
                disabled: true,
                title:
                  'Support branches are long-lived and are not finished (git-flow). Publish or delete it.',
                onSelect: () => undefined,
              },
          {
            label: remote ? `Publish to ${remote}` : 'Publish',
            disabled: !remote,
            title: remote ? undefined : 'This repository has no remotes',
            onSelect: () =>
              remote &&
              quiet(
                runOp(
                  repoId,
                  { type: 'push', localRef: branch, remote, remoteBranch: branch, setUpstream: true },
                  { successToast: `Published ${branch} to ${remote}` },
                ),
              ),
          },
          'separator',
          {
            label: `Delete ${branch}…`,
            danger: true,
            onSelect: async () => {
              if (
                await confirm(
                  `Delete ${branch}?`,
                  'The local branch is deleted. Unmerged commits can be recovered with Undo.',
                  'Delete',
                  true,
                )
              ) {
                quiet(
                  runOp(
                    repoId,
                    { type: 'branch.delete', branches: [{ name: branch }], force: true },
                    { successToast: `Deleted ${branch}` },
                  ),
                );
              }
            },
          },
        ]);
      }}
    >
      <GitBranch size={13} />
      <span className={leftStyles.name}>{name}</span>
    </div>
  );
}

/** "Git Flow finish paused" notice with Continue / Abort (spec 12 §6.9). */
function PausedNotice({ repoId, pending }: { repoId: RepoId; pending: GitflowPendingFinish }) {
  const busy = useIsRunning(repoId, [...PAUSED_OPS]);
  const onContinue = (): void =>
    quiet(
      runOp(
        repoId,
        { type: 'gitflow.continue' },
        { successToast: (r) => r.summary ?? 'Git Flow finish completed' },
      ),
    );
  const onAbort = async (): Promise<void> => {
    const ok = await confirm(
      `Abort finishing ${pending.branch}?`,
      `The ${pending.waitingOn} in progress is aborted and the steps already done are rolled back.`,
      'Abort finish',
      true,
    );
    if (ok) quiet(runOp(repoId, { type: 'gitflow.abort' }, { successToast: (r) => r.summary ?? 'Aborted' }));
  };
  return (
    <div className={styles.notice} role="status">
      <span className={styles.noticeTitle}>
        <TriangleAlert size={13} aria-hidden /> Git Flow finish paused: resolve conflicts then Continue
      </span>
      <span className={styles.noticeStep}>
        Finishing {pending.branch}: {pending.step}
        {pending.remaining.length ? `, then ${pending.remaining.join(', ')}` : ''}
      </span>
      <div className={styles.noticeButtons}>
        <button type="button" className="primary" disabled={busy} onClick={onContinue}>
          Continue
        </button>
        <button type="button" className={styles.danger} disabled={busy} onClick={() => void onAbort()}>
          Abort
        </button>
      </div>
    </div>
  );
}
