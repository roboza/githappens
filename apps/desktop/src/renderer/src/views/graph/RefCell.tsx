import type { RefPill } from '@githappens/graph';
import type { RepoInfo, Sha, StatusResult } from '@githappens/git/types';
import { Archive, Cloud, Crosshair, Eye, EyeOff, GitBranch, Laptop, Tag } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import { dragProps } from '../../actions/dnd';
import type { DragSource } from '../../actions/drop-actions';
import { IssueLinkBadge } from '../issues/IssueLinkBadge';
import { PillConflictBadge } from '../merge/prediction';
import { conflictLabel } from './graph-nav';
import styles from './GraphView.module.css';

/** Icons of a pill (spec 04 §4.5): local laptop, remote cloud, tag, stash, detached HEAD. */
export function PillIcons({ pill }: { pill: RefPill }) {
  if (pill.kind === 'tag') return <Tag size={11} />;
  if (pill.kind === 'stash') return <Archive size={11} />;
  if (pill.kind === 'detached') return <GitBranch size={11} />;
  return (
    <>
      {pill.hasLocal && <Laptop size={11} />}
      {pill.hasRemote && <Cloud size={11} />}
    </>
  );
}

export function pillTooltip(pill: RefPill): string {
  const track =
    pill.ahead || pill.behind
      ? ` ↑${pill.ahead ?? 0} ↓${pill.behind ?? 0}`
      : pill.upstreamGone
        ? ' (upstream gone)'
        : '';
  const wt = pill.worktreePath ? `\nChecked out in ${pill.worktreePath}` : '';
  // annotated tag message on hover (spec 05 §2.2); the ref is the spec 02 RefInfo, which carries `subject`
  const subject = pill.isAnnotatedTag ? (pill.ref as { subject?: string } | undefined)?.subject : undefined;
  return pill.refs.join('\n') + track + wt + (subject ? `\n\n${subject}` : '');
}

export interface PillHandlers {
  onHover(tip: Sha | null): void;
  onMenu(x: number, y: number): void;
  onDoubleClick(): void;
  onHide?(): void;
  onSolo?(): void;
  /** Middle click toggles hide (spec 04 §4.7, our addition). */
  onMiddleClick?(): void;
}

/** A ref pill with hover hide / solo icons (spec 04 §4.5). */
export function RefPillView({
  pill,
  color,
  drag,
  soloed,
  h,
}: {
  pill: RefPill;
  color: string;
  drag?: DragSource;
  soloed?: boolean;
  h: PillHandlers;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  });
  return (
    <span
      className={`${styles.pill} ${pill.isCheckedOut ? styles.headPill : ''}`}
      style={{ borderColor: color, background: `color-mix(in srgb, ${color} 22%, transparent)` }}
      title={pillTooltip(pill)}
      data-ref={pill.fullName}
      onMouseEnter={() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => h.onHover(pill.sha), 60); // spec 04 §6.6: debounce highlight
      }}
      onMouseLeave={() => {
        if (timer.current) clearTimeout(timer.current);
        h.onHover(null);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        h.onMenu(e.clientX, e.clientY);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        h.onDoubleClick();
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && h.onMiddleClick) {
          e.preventDefault();
          e.stopPropagation();
          h.onMiddleClick();
        }
      }}
      {...(drag
        ? {
            draggable: true,
            onDragStart: (e: React.DragEvent) => {
              e.stopPropagation(); // the pill, not the row, is the drag source
              dragProps(drag).onDragStart(e);
            },
          }
        : {})}
    >
      {pill.isCheckedOut && <span aria-label="checked out">✓</span>}
      <PillIcons pill={pill} />
      <span className={styles.pillLabel}>{pill.label}</span>
      <PillConflictBadge pill={pill} />
      <IssueLinkBadge pill={pill} />
      {(h.onHide || h.onSolo) && (
        <span className={`${styles.pillActions} ${soloed ? styles.pillActionsOn : ''}`}>
          {h.onSolo && (
            <button
              type="button"
              className={`${styles.pillAction} ${soloed ? styles.soloOn : ''}`}
              title={soloed ? 'Unsolo' : 'Solo'}
              aria-label={soloed ? 'Unsolo' : 'Solo'}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                h.onSolo!();
              }}
            >
              <Crosshair size={10} />
            </button>
          )}
          {h.onHide && (
            <button
              type="button"
              className={styles.pillAction}
              title="Hide"
              aria-label="Hide"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                h.onHide!();
              }}
            >
              <Eye size={10} />
            </button>
          )}
        </span>
      )}
    </span>
  );
}

/** Faded pill for refs hidden on this row; the eye shows them again. */
export function HiddenGhostPill({ label, count, onShow }: { label: string; count: number; onShow(): void }) {
  return (
    <span
      className={`${styles.pill} ${styles.ghostHidden}`}
      title={`Hidden: ${label}${count > 1 ? ` (+${count - 1})` : ''}`}
    >
      <button
        type="button"
        className={styles.pillAction}
        aria-label="Show hidden ref"
        title="Show in graph"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onShow();
        }}
      >
        <EyeOff size={10} />
      </button>
      <span className={styles.pillLabel}>{label}</span>
      {count > 1 && <span className={styles.ghostCount}>+{count - 1}</span>}
    </span>
  );
}

/** Ghost branch (§6.7): nearest branch containing the hovered / selected commit, at 40% opacity. */
export function NearestBranchGhost({ name, remote }: { name: string; remote?: boolean }) {
  return (
    <span className={`${styles.pill} ${styles.ghostBranch}`} title={`On ${name}`}>
      {remote ? <Cloud size={11} /> : <GitBranch size={11} />}
      <span className={styles.pillLabel}>{name}</span>
    </span>
  );
}

/** "+N" popover listing every ref of a row (spec 04 §4.5); entries drag, right-click and double-click. */
export function RefsPopover({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 280);
  const top = Math.min(y, window.innerHeight - 260);
  return (
    <div
      ref={ref}
      className={styles.popover}
      style={{ left, top }}
      role="dialog"
      aria-label="All refs on this commit"
    >
      {children}
    </div>
  );
}

export function PopoverEntry({
  pill,
  hidden,
  drag,
  onMenu,
  onDoubleClick,
  onToggleHidden,
}: {
  pill: RefPill;
  hidden?: boolean;
  drag?: DragSource;
  onMenu(x: number, y: number): void;
  onDoubleClick(): void;
  onToggleHidden?(): void;
}) {
  return (
    <div
      className={`${styles.popoverEntry} ${hidden ? styles.popoverHidden : ''}`}
      title={pillTooltip(pill)}
      data-ref={pill.fullName}
      {...(drag ? dragProps(drag) : {})}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      onDoubleClick={onDoubleClick}
    >
      {pill.isCheckedOut && <span aria-label="checked out">✓</span>}
      <PillIcons pill={pill} />
      <span className={styles.pillLabel}>{pill.label}</span>
      {onToggleHidden && (
        <button
          type="button"
          className={styles.pillAction}
          title={hidden ? 'Show in graph' : 'Hide'}
          aria-label={hidden ? 'Show' : 'Hide'}
          onClick={(e) => {
            e.stopPropagation();
            onToggleHidden();
          }}
        >
          {hidden ? <EyeOff size={11} /> : <Eye size={11} />}
        </button>
      )}
    </div>
  );
}

export function wipCounts(status: StatusResult | undefined): {
  modified: number;
  added: number;
  deleted: number;
  conflicted: number;
} {
  const entries = status?.entries.filter((e) => e.kind !== 'ignored') ?? [];
  const conflicted = entries.filter((e) => e.kind === 'unmerged').length;
  const added = entries.filter(
    (e) => e.kind === 'untracked' || (e.kind === 'ordinary' && (e.index === 'A' || e.worktree === 'A')),
  ).length;
  const deleted = entries.filter(
    (e) => e.kind === 'ordinary' && (e.index === 'D' || e.worktree === 'D'),
  ).length;
  return { modified: entries.length - added - deleted - conflicted, added, deleted, conflicted };
}

export function WipLabel({
  status,
  kind,
  state,
  draft,
}: {
  status: StatusResult | undefined;
  kind: 'wip' | 'conflict' | null;
  state: RepoInfo['state'];
  draft?: string;
}) {
  const c = wipCounts(status);
  if (kind === 'conflict') {
    return (
      <span className={styles.conflict}>
        {conflictLabel(state)} — {c.conflicted} file{c.conflicted === 1 ? '' : 's'}
      </span>
    );
  }
  return (
    <span className={styles.wip}>
      <span>{'// WIP'}</span>
      {draft?.trim() && <span className={styles.wipDraft}>{draft.trim()}</span>}
      <span className={styles.wipCounts}>
        {c.modified > 0 && <span className={styles.modified}>✎{c.modified}</span>}
        {c.added > 0 && <span className={styles.added}>+{c.added}</span>}
        {c.deleted > 0 && <span className={styles.deleted}>−{c.deleted}</span>}
      </span>
    </span>
  );
}
