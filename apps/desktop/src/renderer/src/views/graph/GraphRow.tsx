import { WIP_SHA, type GhostCandidate, type GraphModel, type RefPill } from '@githappens/graph';
import type {
  CommitSummary,
  RefInfo,
  RepoId,
  RepoInfo,
  StashEntry,
  StatusResult,
} from '@githappens/git/types';
import type { PrIndexEntry } from '@githappens/providers/types';
import { memo, type MouseEvent } from 'react';

import type { GraphColumnId } from '../../../../shared/ipc/graph-contract';
import { dragProps, dropProps, refTarget } from '../../actions/dnd';
import { avatarFailed, avatarSrc, markAvatarFailed } from '../../components/Avatar';
import { authorInitials, type formatDate, fullDate, shortSha } from '../../lib/format';
import { useFormattedDate } from '../../lib/relative-clock';
import { PrBadge } from '../pr/PrBadge';
import { rowAriaLabel } from './graph-nav';
import styles from './GraphView.module.css';
import { HiddenGhostPill, NearestBranchGhost, RefPillView, WipLabel, type PillHandlers } from './RefCell';

export const AVATAR_PX = 16;

const IMG_STYLE = { flex: 'none', borderRadius: '50%', objectFit: 'cover' } as const;
const INITIALS_STYLE = {
  display: 'inline-grid',
  placeItems: 'center',
  flex: 'none',
  width: AVATAR_PX,
  height: AVATAR_PX,
  borderRadius: '50%',
  color: '#fff',
  fontSize: Math.max(9, Math.round(AVATAR_PX * 0.4)),
  fontWeight: 600,
  letterSpacing: '0.02em',
} as const;

/**
 * Same DOM as `<Avatar size={16}>`, without its per-instance hooks: the view passes the avatar policy and
 * cache version down, so a row re-renders only when its author or the avatar cache changes.
 */
function rowAvatar(name: string, email: string, on: boolean) {
  const src = on ? avatarSrc({ email }, AVATAR_PX) : null;
  if (src && !avatarFailed(src)) {
    return (
      <img
        src={src}
        alt=""
        width={AVATAR_PX}
        height={AVATAR_PX}
        style={IMG_STYLE}
        draggable={false}
        onError={() => markAvatarFailed(src)}
      />
    );
  }
  const { text, color } = authorInitials(name, email);
  return (
    <span aria-hidden style={{ ...INITIALS_STYLE, background: color }}>
      {text}
    </span>
  );
}

/**
 * Row callbacks shared by every pooled row. The object is created once per graph view and forwards to
 * the latest handlers, so passing it never breaks `memo` (spec 04 §7.10: rows re-render only when their
 * own content changes).
 */
export interface RowApi {
  mouseDown(row: number, e: MouseEvent): void;
  enter(row: number): void;
  doubleClick(row: number): void;
  contextMenu(row: number, e: MouseEvent): void;
  more(row: number, e: MouseEvent): void;
  showHidden(pills: readonly RefPill[]): void;
  copy(text: string): void;
  pillHandlers(pill: RefPill): PillHandlers;
}

export interface WipInfo {
  status: StatusResult | undefined;
  kind: 'wip' | 'conflict' | null;
  state: RepoInfo['state'];
  draft: string | undefined;
}

export interface RowColumn {
  id: GraphColumnId;
  width: number;
}

export interface GraphRowProps {
  api: RowApi;
  repoId: RepoId;
  model: GraphModel<CommitSummary>;
  row: number;
  /** Offset inside the rows layer (the layer itself moves with the scroll position). */
  y: number;
  height: number;
  columns: readonly RowColumn[];
  pills: readonly RefPill[];
  /** Hidden refs on this row (only when it has no visible pill). */
  hidden: readonly RefPill[];
  color: string;
  selected: boolean;
  match: boolean;
  activeMatch: boolean;
  dim: boolean;
  focused: boolean;
  dateFormat: Parameters<typeof formatDate>[1];
  /** The first pill's ref (drag source / drop target). */
  pillRef: RefInfo | undefined;
  stash: StashEntry | undefined;
  soloed: boolean;
  pr: PrIndexEntry | undefined;
  ghost: GhostCandidate | null;
  wip: WipInfo | null;
  /** Author avatars on (`ui.authorDisplay`). */
  avatars: boolean;
  /** Avatar cache version: re-renders rows when a batch of avatars resolves. */
  avatarVersion: number;
}

/** One commit row of the virtualized graph (refs, message, author, date, sha). */
function GraphRowView(p: GraphRowProps) {
  const { api, model, row, pills, hidden } = p;
  const sha = model.shaAt(row)!;
  const c = model.commitAt(row);
  const first = pills[0];
  // Relative dates follow the shared minute clock; the row re-renders only when its text changes.
  const when = useFormattedDate(c?.authorTime, p.dateFormat);
  // Drag & drop (spec 04 §4.11): rows drag as commits/stashes; drops target the row's ref or commit.
  const dnd =
    sha === WIP_SHA
      ? {}
      : {
          ...dragProps(
            p.stash
              ? { kind: 'stash', sha, index: p.stash.index, message: p.stash.message }
              : { kind: 'commit', sha },
          ),
          ...dropProps(
            p.repoId,
            p.pillRef ? refTarget(p.pillRef) : { kind: 'commit', sha },
            styles.dropTarget,
          ),
        };
  const cells = p.columns.map((col) => {
    const style = { width: col.width, flex: 'none' as const };
    switch (col.id) {
      case 'refs':
        return (
          <div key="refs" className={styles.refsCell} style={style}>
            {first && (
              <RefPillView
                pill={first}
                color={p.color}
                drag={p.pillRef ? refTarget(p.pillRef) : undefined}
                soloed={p.soloed}
                h={api.pillHandlers(first)}
              />
            )}
            {p.pr && <PrBadge entry={p.pr} repoId={p.repoId} />}
            {pills.length > 1 && (
              <button
                type="button"
                className={styles.more}
                title={pills
                  .slice(1)
                  .map((x) => x.label)
                  .join('\n')}
                aria-label={`${pills.length - 1} more refs`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  api.more(row, e);
                }}
              >
                +{pills.length - 1}
              </button>
            )}
            {!first && hidden.length > 0 && (
              <HiddenGhostPill
                label={hidden[0]!.label}
                count={hidden.length}
                onShow={() => api.showHidden(hidden)}
              />
            )}
            {!first && !hidden.length && p.ghost && (
              <NearestBranchGhost name={p.ghost.name} remote={p.ghost.remote} />
            )}
          </div>
        );
      case 'graph':
        return <div key="graph" style={style} />;
      case 'message':
        return (
          <div key="message" className={styles.message} style={style}>
            {sha === WIP_SHA ? (
              p.wip && (
                <WipLabel status={p.wip.status} kind={p.wip.kind} state={p.wip.state} draft={p.wip.draft} />
              )
            ) : c ? (
              <span title={c.subject}>{c.subject}</span>
            ) : (
              <span className={styles.stashMsg}>
                {(model.itemAt(row) as StashEntry | null | undefined)?.message ?? ''}
              </span>
            )}
          </div>
        );
      case 'author':
        return (
          <div key="author" className={styles.cell} style={style}>
            {c && (
              <>
                {rowAvatar(c.authorName, c.authorEmail, p.avatars)}
                <span className={styles.ellipsis}>{c.authorName}</span>
              </>
            )}
          </div>
        );
      case 'date':
        return (
          <div key="date" className={styles.cell} style={style} title={c ? fullDate(c.authorTime) : ''}>
            {when}
          </div>
        );
      case 'sha':
        return (
          <div
            key="sha"
            className={`${styles.cell} ${styles.shaCell} mono`}
            style={style}
            title={c ? 'Click to copy SHA' : ''}
            onClick={(e) => {
              if (!c) return;
              e.stopPropagation();
              api.copy(c.sha);
            }}
          >
            {c ? shortSha(c.sha) : ''}
          </div>
        );
      default:
        return null;
    }
  });
  return (
    <div
      {...dnd}
      role="row"
      aria-rowindex={row + 1}
      aria-selected={p.selected}
      aria-label={rowAriaLabel(model, row, pills, when)}
      className={`${styles.row} ${p.selected ? styles.selected : ''} ${p.match ? styles.match : ''} ${
        p.activeMatch ? styles.activeMatch : ''
      } ${p.dim ? styles.dim : ''} ${p.focused ? styles.focused : ''}`}
      style={{ top: p.y, height: p.height }}
      onMouseDown={(e) => {
        if (e.button === 0) api.mouseDown(row, e);
      }}
      onMouseEnter={() => api.enter(row)}
      onDoubleClick={() => api.doubleClick(row)}
      onContextMenu={(e) => {
        e.preventDefault();
        api.contextMenu(row, e);
      }}
      data-row={row}
    >
      {cells}
    </div>
  );
}

export const GraphRow = memo(GraphRowView);
