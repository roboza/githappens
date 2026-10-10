import { describeSnooze, SNOOZE_PRESETS, snoozeFor, type ClassifiedItem } from '@githappens/launchpad';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlarmClock,
  Archive,
  CircleCheck,
  CircleDot,
  CircleX,
  Clock,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  MoreHorizontal,
  Pin,
  PinOff,
  TriangleAlert,
  UserX,
} from 'lucide-react';
import type { CSSProperties, MouseEvent } from 'react';

import { useContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { copyText } from '../../integrations/api';
import { UserAvatar } from '../../integrations/ui';
import {
  checkoutItem,
  checkoutItemInWorktree,
  commitWip,
  createBranchForItem,
  openInBrowser,
  openItem,
  stashWip,
} from '../../launchpad/actions';
import { ago, canMergeFromLaunchpad, prGlyphs, wipLabel, type StatusGlyph } from '../../launchpad/helpers';
import { setItemState } from '../../launchpad/queries';
import { useTabsStore } from '../../stores/tabs';
import s from './Launchpad.module.css';

const tone = (t: string): string => s[`tone-${t}`] ?? '';

function Glyph({ g }: { g: StatusGlyph }) {
  const props = { size: 13, className: tone(g.tone), 'aria-label': g.label };
  const icon =
    g.kind === 'conflict' ? (
      <TriangleAlert {...props} />
    ) : g.kind === 'no-reviewers' ? (
      <UserX {...props} />
    ) : g.kind === 'draft' ? (
      <GitPullRequestDraft {...props} />
    ) : g.kind === 'ci' ? (
      g.tone === 'green' ? (
        <CircleCheck {...props} />
      ) : g.tone === 'red' ? (
        <CircleX {...props} />
      ) : (
        <Clock {...props} />
      )
    ) : g.tone === 'green' ? (
      <CircleCheck {...props} />
    ) : g.tone === 'red' ? (
      <CircleX {...props} />
    ) : (
      <CircleDot {...props} />
    );
  return <span title={g.label}>{icon}</span>;
}

/** Snooze menu entries (§4.2) for an item. */
export function snoozeMenu(qc: ReturnType<typeof useQueryClient>, item: ClassifiedItem): MenuEntry[] {
  const entries: MenuEntry[] = SNOOZE_PRESETS.map((p) => ({
    label: p.label,
    onSelect: () => void setItemState(qc, item, { snooze: snoozeFor(p.id, Date.now(), item.updatedAt) }),
  }));
  if (item.snoozed) {
    entries.unshift(
      {
        label: `Unsnooze (${describeSnooze(item.snoozed, Date.now())})`,
        onSelect: () => void setItemState(qc, item, { snooze: null }),
      },
      'separator',
    );
  }
  return entries;
}

export function itemMenu(
  qc: ReturnType<typeof useQueryClient>,
  item: ClassifiedItem,
  onMerge: (() => void) | undefined,
): MenuEntry[] {
  const pinned = !!item.pinnedAt;
  const entries: MenuEntry[] = [
    { label: 'Open', shortcut: 'Enter', onSelect: () => void openItem(item) },
    { label: 'Open in browser', shortcut: 'O', disabled: !item.webUrl, onSelect: () => openInBrowser(item) },
  ];
  if (item.type === 'pr')
    entries.push(
      { label: 'Checkout', shortcut: 'C', onSelect: () => void checkoutItem(item) },
      { label: 'Checkout in new worktree', onSelect: () => void checkoutItemInWorktree(item) },
    );
  if (item.type === 'issue')
    entries.push({ label: 'Create branch…', shortcut: 'C', onSelect: () => void createBranchForItem(item) });
  if (item.type === 'wip')
    entries.push(
      {
        label: 'Open repository',
        onSelect: () => void useTabsStore.getState().openRepo(item.status.path),
      },
      { label: 'Stash changes…', onSelect: () => void stashWip(item, qc) },
      { label: 'Commit…', onSelect: () => void commitWip(item) },
    );
  if (onMerge) entries.push({ label: 'Merge…', shortcut: 'M', onSelect: onMerge });
  entries.push(
    'separator',
    {
      label: pinned ? 'Unpin' : 'Pin',
      shortcut: 'P',
      onSelect: () => void setItemState(qc, item, { pin: !pinned }),
    },
    ...snoozeMenu(qc, item).map((e) => (e === 'separator' ? e : { ...e, label: `Snooze: ${e.label}` })),
  );
  if (item.webUrl) entries.push('separator', { label: 'Copy link', onSelect: () => copyText(item.webUrl!) });
  return entries;
}

interface RowProps {
  item: ClassifiedItem;
  selected: boolean;
  style: CSSProperties;
  onSelect(): void;
  onMerge(anchor: DOMRect): void;
  now: number;
}

/** One Launchpad row: PR / issue / WIP (§4.2 LaunchpadRow). */
export function LaunchpadRow({ item, selected, style, onSelect, onMerge, now }: RowProps) {
  const qc = useQueryClient();
  const showMenu = useContextMenu((st) => st.show);
  const mergeable = canMergeFromLaunchpad(item);
  const btn = (e: MouseEvent, fn: () => void) => {
    e.stopPropagation();
    fn();
  };
  const at = (e: MouseEvent): [number, number] => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [r.left, r.bottom + 2];
  };
  const mergeAt = (el: HTMLElement) => onMerge(el.getBoundingClientRect());

  return (
    <div
      role="option"
      aria-selected={selected}
      className={`${s.row} ${selected ? s.selected : ''}`}
      style={style}
      onClick={onSelect}
      onDoubleClick={() => void openItem(item)}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect();
        const target = e.currentTarget;
        showMenu(e.clientX, e.clientY, itemMenu(qc, item, mergeable ? () => mergeAt(target) : undefined));
      }}
      data-uid={item.uid}
    >
      {item.pinnedAt && <Pin size={12} className={s.pinMark} aria-label="Pinned" />}
      {item.type === 'pr' ? (
        <>
          <GitPullRequest size={14} className={s.typeIcon} aria-hidden />
          <span className={s.glyphs}>
            {prGlyphs(item).map((g) => (
              <Glyph key={g.kind + g.label} g={g} />
            ))}
          </span>
          <span className={s.rowTitle} title={item.title}>
            {item.title}
            <span className={s.num}>#{item.pr.number}</span>
          </span>
          {(item.pr.additions !== undefined || item.pr.deletions !== undefined) && (
            <span className={s.diff}>
              <span className={s.added}>+{item.pr.additions ?? 0}</span>
              <span className={s.deleted}>−{item.pr.deletions ?? 0}</span>
            </span>
          )}
          <span className={s.repo} title={item.repo?.fullName}>
            {item.repo?.fullName}
          </span>
          <span className={s.branch} title={`${item.pr.head.branch} → ${item.pr.base.branch}`}>
            {item.pr.head.branch} → {item.pr.base.branch}
          </span>
          <span className={s.avatars}>
            <span title={`Author: ${item.pr.author.login}`}>
              <UserAvatar user={item.pr.author} size={18} />
            </span>
            {item.pr.reviewers.slice(0, 3).map((r) => (
              <span key={r.user.id || r.user.login} title={`${r.user.login}: ${r.state}`}>
                <UserAvatar user={r.user} size={16} />
              </span>
            ))}
          </span>
        </>
      ) : item.type === 'issue' ? (
        <>
          <CircleDot size={14} className={s.typeIcon} aria-hidden />
          <span className={s.num}>{item.issue.key}</span>
          <span className={s.rowTitle} title={item.title}>
            {item.title}
          </span>
          <span className={s.chip}>{item.issue.state}</span>
          {item.issue.priority && <span className={s.chip}>{item.issue.priority}</span>}
          <span className={s.repo}>{item.repo?.fullName}</span>
          <span className={s.avatars}>
            {item.issue.assignees.slice(0, 2).map((a) => (
              <span key={a.id || a.login} title={`Assignee: ${a.login}`}>
                <UserAvatar user={a} size={18} />
              </span>
            ))}
          </span>
        </>
      ) : (
        <>
          <FolderGit2 size={14} className={s.typeIcon} aria-hidden />
          <span className={s.rowTitle} title={item.status.path}>
            {item.status.name}
          </span>
          {item.status.branch && (
            <span className={s.branch}>
              <GitBranch size={11} aria-hidden /> {item.status.branch}
            </span>
          )}
          <span className={s.chip}>{wipLabel(item.status)}</span>
        </>
      )}
      {item.snoozed && (
        <span className={s.chip} title="Snoozed">
          <AlarmClock size={10} aria-hidden /> {describeSnooze(item.snoozed, now)}
        </span>
      )}
      <span className={s.updated} title={item.updatedAt}>
        {ago(item.type === 'wip' ? (item.status.lastModified ?? item.updatedAt) : item.updatedAt, now)}
      </span>
      <span className={s.actions}>
        {item.type === 'pr' && (
          <button
            type="button"
            className={s.actionBtn}
            title="Checkout (C)"
            aria-label="Checkout"
            onClick={(e) => btn(e, () => void checkoutItem(item))}
          >
            <GitBranch size={13} />
          </button>
        )}
        {item.type === 'issue' && (
          <button
            type="button"
            className={s.actionBtn}
            title="Create branch (C)"
            aria-label="Create branch"
            onClick={(e) => btn(e, () => void createBranchForItem(item))}
          >
            <GitBranch size={13} />
          </button>
        )}
        {item.type === 'wip' ? (
          <>
            <button
              type="button"
              className={s.actionBtn}
              title="Open repository"
              aria-label="Open repository"
              onClick={(e) => btn(e, () => void useTabsStore.getState().openRepo(item.status.path))}
            >
              <FolderGit2 size={13} />
            </button>
            <button
              type="button"
              className={s.actionBtn}
              title="Stash changes"
              aria-label="Stash changes"
              onClick={(e) => btn(e, () => void stashWip(item, qc))}
            >
              <Archive size={13} />
            </button>
            <button
              type="button"
              className={s.actionBtn}
              title="Commit… (opens the repository on its WIP)"
              aria-label="Commit"
              onClick={(e) => btn(e, () => void commitWip(item))}
            >
              <GitCommitHorizontal size={13} />
            </button>
          </>
        ) : (
          <button
            type="button"
            className={s.actionBtn}
            title="Open in browser (O)"
            aria-label="Open in browser"
            onClick={(e) => btn(e, () => openInBrowser(item))}
          >
            <ExternalLink size={13} />
          </button>
        )}
        {mergeable && (
          <button
            type="button"
            className={s.actionBtn}
            title="Merge (M)"
            aria-label="Merge"
            onClick={(e) => btn(e, () => mergeAt(e.currentTarget as HTMLElement))}
          >
            <GitMerge size={13} />
          </button>
        )}
        <button
          type="button"
          className={s.actionBtn}
          title={item.pinnedAt ? 'Unpin (P)' : 'Pin (P)'}
          aria-label={item.pinnedAt ? 'Unpin' : 'Pin'}
          onClick={(e) => btn(e, () => void setItemState(qc, item, { pin: !item.pinnedAt }))}
        >
          {item.pinnedAt ? <PinOff size={13} /> : <Pin size={13} />}
        </button>
        <button
          type="button"
          className={s.actionBtn}
          title="Snooze (S)"
          aria-label="Snooze"
          onClick={(e) => btn(e, () => showMenu(...at(e), snoozeMenu(qc, item)))}
        >
          <AlarmClock size={13} />
        </button>
        <button
          type="button"
          className={s.actionBtn}
          title="More actions"
          aria-label="More actions"
          onClick={(e) => {
            const target = e.currentTarget.closest('[role="option"]') as HTMLElement;
            btn(e, () =>
              showMenu(...at(e), itemMenu(qc, item, mergeable ? () => mergeAt(target) : undefined)),
            );
          }}
        >
          <MoreHorizontal size={13} />
        </button>
      </span>
    </div>
  );
}
