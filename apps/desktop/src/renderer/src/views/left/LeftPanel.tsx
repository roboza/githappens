import { stashKey } from '@githappens/graph';
import type { RefInfo, RepoId, StashEntry } from '@githappens/git/types';
import {
  Archive,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Cloud,
  Folder,
  FolderTree,
  GitBranch,
  GitPullRequest,
  PlayCircle,
  Laptop,
  Maximize2,
  RefreshCw,
  Search,
  Tag,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { dragProps, dropProps, refTarget } from '../../actions/dnd';
import { checkout } from '../../actions/git-actions';
import { checkoutTargetFor, refMenu, stashMenu } from '../../actions/menus';
import { registerCommands } from '../../commands/registry';
import { useContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { usePrIndex } from '../../integrations/queries';
import { buildTree, fuzzyMatch } from '../../lib/format';
import { useRefs, useRemotes, useRepoInfo, useStashes } from '../../repo/queries';
import { useRepoUi, useRepoUiStore } from '../../stores/repo-ui';
import { useSetting } from '../../stores/settings';
import {
  isSectionOpen,
  isSectionShown,
  setSectionHeight,
  setSectionShown,
  toggleCollapsed,
  toggleMaximized,
  type LeftPanelLayout,
} from '../../../../shared/left-panel/layout';
import { AgentSessionsPanel } from '../agents/AgentSessionsPanel';
import { CiSection, useCiSectionTitle } from '../ci/CiSection';
import { CloudPatchesSection } from '../cloud-patches';
import { gitflowCommands, GitFlowSection } from '../gitflow';
import { hideRef } from '../graph/repo-graph-state';
import { RefVisibilityToggle, sectionVisibilityItems, StashVisibilityToggle } from '../graph/visibility-ui';
import { IssuesSection } from '../issues/IssuesSection';
import { lfsCommands } from '../lfs/lfs-actions';
import { PullRequestsSection } from '../pr/PullRequestsSection';
import { deleteBranches } from '../remotes/branch-actions';
import { openAddRemote, openAddSubmodule } from '../remotes/dialog-store';
import { LeftDialogsHost } from '../remotes/LeftDialogsHost';
import { fetchRemote, remoteMenu, remoteSectionItems } from '../remotes/remote-actions';
import { groupRemotes, type RemoteGroup } from '../remotes/remote-model';
import { SubmoduleParentBanner } from '../submodules/SubmoduleParentBanner';
import { submoduleSectionItems } from '../submodules/submodule-actions';
import { TeamSection } from '../team/TeamSection';
import { worktreeSectionItems } from '../worktrees/worktree-actions';
import { worktreeMatchText } from '../worktrees/worktree-model';
import { useLeftLayout, updateLeftLayout } from './left-layout-store';
import {
  DEFAULT_VIRTUAL_HEIGHT,
  deletableBranches,
  flattenRefTree,
  highlightSegments,
  nextSelection,
  VIRTUALIZE_THRESHOLD,
  type FlatRow,
} from './left-panel-model';
import styles from './LeftPanel.module.css';
import {
  AddButton,
  createWorktree,
  SubmoduleRow,
  useSubmodules,
  useWorktrees,
  WorktreeRow,
} from './RepoExtrasSections';
import { VirtualRows } from './VirtualRows';

type SectionId =
  'local' | 'remote' | 'tags' | 'stashes' | 'submodules' | 'worktrees' | 'pulls' | 'issues' | 'ci';

const TITLES: Record<SectionId, string> = {
  local: 'Local',
  remote: 'Remote',
  tags: 'Tags',
  stashes: 'Stashes',
  submodules: 'Submodules',
  worktrees: 'Worktrees',
  pulls: 'Pull requests',
  issues: 'Issues',
  ci: 'CI',
};
const ORDER: SectionId[] = [
  'local',
  'remote',
  'tags',
  'stashes',
  'submodules',
  'worktrees',
  'pulls',
  'issues',
  'ci',
];
/** Hidden by default; enabled from a section header menu (spec 09 §2 "Submodules … hidden by default"). */
const OPT_IN: ReadonlySet<SectionId> = new Set(['submodules']);

interface Props {
  repoId: RepoId;
}

type RemoteRow = FlatRow | { kind: 'remote'; key: string; group: RemoteGroup; open: boolean };

/** Left panel (spec 01 §4.5): Local / Remote / Tags / Stashes / … with filter, folder trees and layout. */
export function LeftPanel({ repoId }: Props) {
  const refs = useRefs(repoId);
  const remotesQ = useRemotes(repoId);
  const stashes = useStashes(repoId);
  const info = useRepoInfo(repoId).data;
  const submodules = useSubmodules(repoId);
  const worktrees = useWorktrees(repoId);
  const filter = useRepoUi(repoId, (u) => u.leftFilter);
  const collapsedFolders = useRepoUi(repoId, (u) => u.collapsedFolders);
  const update = useRepoUiStore((s) => s.update);
  const layout = useLeftLayout(repoId);
  const showMenu = useContextMenu((s) => s.show);
  const prIndex = usePrIndex(repoId);
  const showAgentsToggle = useSetting('ui.showAgentsToggle');
  const [mode, setMode] = useState<'list' | 'agents'>('list');
  // multi-select in the Local tree (scoped to the repo shown)
  const [sel, setSel] = useState<{ repoId: RepoId; selected: string[]; anchor: string | null }>({
    repoId,
    selected: [],
    anchor: null,
  });
  const selected = sel.repoId === repoId ? sel.selected : [];
  const anchor = sel.repoId === repoId ? sel.anchor : null;
  const setSelected = (s: string[]): void => setSel((x) => ({ repoId, selected: s, anchor: x.anchor }));
  const setAnchor = (a: string | null): void => setSel((x) => ({ ...x, repoId, anchor: a }));
  // Git Flow + LFS palette commands follow the active repo (spec 12 §4.9, spec 09 §4.2).
  useEffect(() => registerCommands([...gitflowCommands(repoId), ...lfsCommands(repoId)]), [repoId]);
  const openPrCount = useMemo(() => new Set([...prIndex.values()].map((e) => e.pr.number)).size, [prIndex]);

  const q = filter.trim();
  const all = useMemo(() => refs.data ?? [], [refs.data]);
  const hits = useMemo(() => {
    const m = new Map<string, number[]>();
    if (!q) return m;
    for (const r of all) {
      const h = fuzzyMatch(r.shortName, q);
      if (h) m.set(r.fullName, h);
    }
    return m;
  }, [all, q]);
  const { local, remote, tags } = useMemo(() => {
    const keep = (r: RefInfo): boolean => !q || hits.has(r.fullName);
    return {
      local: all.filter((r) => r.type === 'local' && keep(r)),
      remote: all.filter((r) => r.type === 'remote' && !r.symrefTarget && keep(r)),
      tags: all.filter((r) => r.type === 'tag' && keep(r)),
    };
  }, [all, hits, q]);
  const stashList = (stashes.data ?? []).filter(
    (s) => !q || fuzzyMatch(`stash@{${s.index}} ${s.message}`, q),
  );
  const submoduleList = (submodules.data ?? []).filter((m) => !q || fuzzyMatch(m.path, q));
  const worktreeList = (worktrees.data ?? []).filter(
    (w) => !w.bare && (!q || fuzzyMatch(worktreeMatchText(w), q)),
  );
  const groups = useMemo(() => groupRemotes(remotesQ.data ?? [], remote, !!q), [remotesQ.data, remote, q]);

  const toggleFolder = (key: string): void =>
    update(repoId, (u) => ({
      collapsedFolders: u.collapsedFolders.includes(key)
        ? u.collapsedFolders.filter((f) => f !== key)
        : [...u.collapsedFolders, key],
    }));

  const localRows = useMemo(
    () =>
      flattenRefTree(
        buildTree(local, (r) => r.shortName),
        { prefix: 'local', collapsed: (k) => collapsedFolders.includes(k), forceOpen: !!q },
      ),
    [local, collapsedFolders, q],
  );
  const tagRows = useMemo(
    () =>
      flattenRefTree(
        buildTree(tags, (r) => r.shortName),
        { prefix: 'tags', collapsed: (k) => collapsedFolders.includes(k), forceOpen: !!q },
      ),
    [tags, collapsedFolders, q],
  );
  const remoteRows = useMemo(() => {
    const rows: RemoteRow[] = [];
    for (const g of groups) {
      const key = `remote:${g.name}`;
      const open = !!q || !collapsedFolders.includes(key);
      rows.push({ kind: 'remote', key, group: g, open });
      if (!open) continue;
      flattenRefTree(
        buildTree(g.refs, (r) => r.shortName.slice(g.name.length + 1)),
        { prefix: key, depth: 1, collapsed: (k) => collapsedFolders.includes(k), forceOpen: !!q },
        rows as FlatRow[],
      );
    }
    return rows;
  }, [groups, collapsedFolders, q]);

  const localOrder = useMemo(
    () => localRows.filter((r): r is Extract<FlatRow, { kind: 'ref' }> => r.kind === 'ref').map((r) => r.key),
    [localRows],
  );

  const sectionNames = (id: SectionId): string[] => {
    if (id === 'local') return local.map((r) => r.fullName);
    if (id === 'remote') return remote.map((r) => r.fullName);
    if (id === 'tags') return tags.map((r) => r.fullName);
    if (id === 'stashes') return stashList.map((s) => stashKey(s.sha));
    return [];
  };

  // GitHub "Actions", GitLab/Bitbucket/Azure "Pipelines" (spec 10 CI section).
  const ciTitle = useCiSectionTitle(repoId);
  const counts: Record<SectionId, number> = {
    local: local.length,
    remote: q ? remote.length : groups.length,
    tags: tags.length,
    stashes: stashList.length,
    submodules: submoduleList.length,
    worktrees: worktreeList.length,
    pulls: openPrCount,
    issues: 0,
    ci: 0,
  };
  const hasItems: Partial<Record<SectionId, boolean>> = { submodules: (submodules.data ?? []).length > 0 };
  const shown = (id: SectionId): boolean =>
    isSectionShown(layout, id, { optIn: OPT_IN.has(id), hasItems: hasItems[id] }) &&
    !(id === 'worktrees' && info?.isBare);
  const open = (id: SectionId): boolean =>
    isSectionOpen(layout, id, {
      filterActive: !!q,
      count: id === 'pulls' || id === 'issues' || id === 'ci' ? (q ? 0 : 1) : counts[id],
    });
  const setLayout = (fn: (l: LeftPanelLayout) => LeftPanelLayout): void => updateLeftLayout(repoId, fn);

  const headerMenu = (id: SectionId, e: MouseEvent): void => {
    e.preventDefault();
    const items: MenuEntry[] = [];
    if (id === 'remote') items.push(...remoteSectionItems(repoId));
    if (id === 'worktrees') items.push(...worktreeSectionItems(repoId));
    if (id === 'submodules') items.push(...submoduleSectionItems(repoId, hasItems.submodules ?? false));
    if (['local', 'remote', 'tags', 'stashes'].includes(id)) {
      if (items.length) items.push('separator');
      items.push(...sectionVisibilityItems(repoId, sectionNames(id)));
    }
    if (items.length) items.push('separator');
    items.push(
      {
        label: layout.maximized === id ? 'Restore sections' : `Maximize ${TITLES[id]}`,
        onSelect: () => setLayout((l) => toggleMaximized(l, id)),
      },
      ...(layout.heights[id]
        ? [{ label: 'Reset section height', onSelect: () => setLayout((l) => setSectionHeight(l, id, null)) }]
        : []),
      {
        label: `Hide ${TITLES[id]} section`,
        onSelect: () => setLayout((l) => setSectionShown(l, id, false, OPT_IN.has(id))),
      },
    );
    const hiddenOnes = ORDER.filter((s) => s !== id && !shown(s) && !(s === 'worktrees' && info?.isBare));
    if (hiddenOnes.length) {
      items.push('separator');
      for (const s of hiddenOnes)
        items.push({
          label: `Show ${TITLES[s]} section`,
          onSelect: () => setLayout((l) => setSectionShown(l, s, true, OPT_IN.has(s))),
        });
    }
    showMenu(e.clientX, e.clientY, items);
  };

  /** Body scroll mode: maximized → fill; resized → fixed px; long lists → default height (virtualized). */
  const bodyHeight = (id: SectionId, rows: number): number | 'fill' | undefined => {
    if (layout.maximized === id) return 'fill';
    if (layout.heights[id]) return layout.heights[id];
    return rows > VIRTUALIZE_THRESHOLD ? DEFAULT_VIRTUAL_HEIGHT : undefined;
  };

  const sectionProps = (id: SectionId) => ({
    id,
    title: id === 'ci' ? ciTitle : TITLES[id],
    count: counts[id],
    open: open(id),
    maximized: layout.maximized === id,
    onToggle: () => setLayout((l) => toggleCollapsed(l, id, open(id))),
    onMaximize: () => setLayout((l) => toggleMaximized(l, id)),
    onHeaderMenu: (e: MouseEvent) => headerMenu(id, e),
    onResize: (h: number) => setLayout((l) => setSectionHeight(l, id, h)),
  });

  const onRefClick = (r: RefInfo, e: MouseEvent): void => {
    if (r.type === 'local' && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      const next = nextSelection(
        selected,
        localOrder,
        r.fullName,
        { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey },
        anchor,
      );
      setSelected(next.selected);
      setAnchor(next.anchor);
      return;
    }
    setSelected(r.type === 'local' ? [r.fullName] : []);
    setAnchor(r.type === 'local' ? r.fullName : null);
    useRepoUiStore.getState().reveal(repoId, r.sha);
  };

  const multiMenu = (r: RefInfo): MenuEntry[] | null => {
    if (r.type !== 'local' || selected.length < 2 || !selected.includes(r.fullName)) return null;
    const chosen = all.filter((x) => x.type === 'local' && selected.includes(x.fullName));
    const deletable = deletableBranches(all, selected);
    return [
      {
        label: `Delete ${deletable.length} branch${deletable.length === 1 ? '' : 'es'}…`,
        danger: true,
        disabled: !deletable.length,
        title: chosen.some((x) => x.isHead) ? 'The checked-out branch is skipped' : undefined,
        onSelect: () => void deleteBranches(repoId, deletable).then(() => setSelected([])),
      },
      'separator',
      {
        label: `Hide ${chosen.length} branches`,
        onSelect: () => chosen.forEach((x) => hideRef(repoId, x.fullName, true)),
      },
      {
        label: `Show ${chosen.length} branches`,
        onSelect: () => chosen.forEach((x) => hideRef(repoId, x.fullName, false)),
      },
      { label: 'Clear selection', onSelect: () => setSelected([]) },
    ];
  };

  const renderRefRow = (row: FlatRow): ReactNode =>
    row.kind === 'folder' ? (
      <FolderRow
        name={row.name}
        depth={row.depth}
        open={row.open}
        icon={<Folder size={13} />}
        onToggle={() => toggleFolder(row.key)}
      />
    ) : (
      <RefRow
        repoId={repoId}
        r={row.ref}
        label={row.label}
        depth={row.depth}
        hits={hits.get(row.ref.fullName) ?? null}
        multi={selected.length > 1 && selected.includes(row.ref.fullName)}
        onClick={onRefClick}
        multiMenu={multiMenu}
        allRefs={all}
      />
    );

  return (
    <nav className={styles.panel} aria-label="Repository references">
      {showAgentsToggle && (
        <div className={styles.modeSwitch} role="group" aria-label="Left panel mode">
          <button type="button" aria-pressed={mode === 'list'} onClick={() => setMode('list')}>
            List
          </button>
          <button type="button" aria-pressed={mode === 'agents'} onClick={() => setMode('agents')}>
            Agents
          </button>
        </div>
      )}
      <SubmoduleParentBanner repoId={repoId} />
      <LeftDialogsHost repoId={repoId} />
      {mode === 'agents' && showAgentsToggle ? (
        <div className={styles.sections}>
          <AgentSessionsPanel repoId={repoId} />
        </div>
      ) : (
        <>
          <div className={styles.filter}>
            <Search size={14} aria-hidden />
            <input
              type="text"
              placeholder="Filter (Ctrl+Alt+F)"
              aria-label="Filter branches, tags and stashes"
              data-left-filter
              value={filter}
              onChange={(e) => update(repoId, () => ({ leftFilter: e.target.value }))}
              onKeyDown={(e) => e.key === 'Escape' && update(repoId, () => ({ leftFilter: '' }))}
            />
          </div>
          <div className={`${styles.sections} ${layout.maximized ? styles.hasMaximized : ''}`}>
            {shown('local') && (
              <Section {...sectionProps('local')} icon={<Laptop size={14} />}>
                <VirtualRows
                  label="Local"
                  items={localRows}
                  height={bodyHeight('local', localRows.length)}
                  keyOf={(r) => r.key}
                  render={renderRefRow}
                />
              </Section>
            )}
            {shown('remote') && (
              <Section
                {...sectionProps('remote')}
                icon={<Cloud size={14} />}
                action={<AddButton label="Add remote" onClick={() => openAddRemote(repoId)} />}
                empty={q ? undefined : 'No remotes'}
              >
                <VirtualRows
                  label="Remote"
                  items={remoteRows}
                  height={bodyHeight('remote', remoteRows.length)}
                  keyOf={(r) => r.key}
                  render={(row) =>
                    row.kind === 'remote' ? (
                      <RemoteHeaderRow
                        repoId={repoId}
                        group={row.group}
                        open={row.open}
                        onToggle={() => toggleFolder(row.key)}
                      />
                    ) : (
                      renderRefRow(row)
                    )
                  }
                />
              </Section>
            )}
            {shown('tags') && (
              <Section {...sectionProps('tags')} icon={<Tag size={14} />} empty="No tags">
                <VirtualRows
                  label="Tags"
                  items={tagRows}
                  height={bodyHeight('tags', tagRows.length)}
                  keyOf={(r) => r.key}
                  render={renderRefRow}
                />
              </Section>
            )}
            {shown('stashes') && (
              <Section {...sectionProps('stashes')} icon={<Archive size={14} />} empty="No stashes">
                <VirtualRows
                  label="Stashes"
                  items={stashList}
                  height={bodyHeight('stashes', stashList.length)}
                  keyOf={(s) => s.sha}
                  render={(s) => <StashRow repoId={repoId} stash={s} filter={q} />}
                />
              </Section>
            )}
            {shown('submodules') && (
              <Section
                {...sectionProps('submodules')}
                icon={<Boxes size={14} />}
                empty="No submodules"
                action={<AddButton label="Add submodule" onClick={() => openAddSubmodule(repoId)} />}
              >
                <VirtualRows
                  label="Submodules"
                  items={submoduleList}
                  height={bodyHeight('submodules', submoduleList.length)}
                  keyOf={(m) => m.path}
                  render={(m) => (
                    <SubmoduleRow
                      repoId={repoId}
                      m={m}
                      repoRoot={info?.worktreeRoot ?? null}
                      label={<Highlighted text={m.path} hits={q ? fuzzyMatch(m.path, q) : null} />}
                    />
                  )}
                />
              </Section>
            )}
            {shown('worktrees') && (
              <Section
                {...sectionProps('worktrees')}
                icon={<FolderTree size={14} />}
                action={<AddButton label="Create worktree" onClick={() => createWorktree(repoId)} />}
              >
                <VirtualRows
                  label="Worktrees"
                  items={worktreeList}
                  height={bodyHeight('worktrees', worktreeList.length)}
                  keyOf={(w) => w.path}
                  render={(w) => <WorktreeRow repoId={repoId} w={w} />}
                />
              </Section>
            )}
            {/* Hosting integrations (spec 10 §6): each body brings its own toolbar and connect prompt. */}
            {shown('pulls') && (
              <Section
                {...sectionProps('pulls')}
                icon={<GitPullRequest size={14} />}
                plain
                height={layout.heights.pulls}
              >
                <PullRequestsSection repoId={repoId} />
              </Section>
            )}
            {shown('issues') && (
              <Section
                {...sectionProps('issues')}
                icon={<CircleDot size={14} />}
                hideCount
                plain
                height={layout.heights.issues}
              >
                <IssuesSection repoId={repoId} />
              </Section>
            )}
            {shown('ci') && (
              <Section
                {...sectionProps('ci')}
                icon={<PlayCircle size={14} />}
                hideCount
                plain
                height={layout.heights.ci}
              >
                <CiSection repoId={repoId} active={open('ci')} />
              </Section>
            )}
            {!q && !layout.maximized && <GitFlowSection repoId={repoId} />}
            {!q && !layout.maximized && <CloudPatchesSection repoId={repoId} />}
            {!q && !layout.maximized && <TeamSection repoId={repoId} />}
          </div>
        </>
      )}
    </nav>
  );
}

function Section(props: {
  id: SectionId;
  title: string;
  icon: ReactNode;
  count: number;
  open: boolean;
  maximized: boolean;
  onToggle(): void;
  onMaximize(): void;
  onHeaderMenu(e: MouseEvent): void;
  onResize(height: number): void;
  empty?: string;
  action?: ReactNode;
  hideCount?: boolean;
  /** Body is a self-contained component (not a VirtualRows list): wrap it in a scroller when sized. */
  plain?: boolean;
  /** Stored height of a `plain` body (px). */
  height?: number;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const startResize = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const body = bodyRef.current;
    if (!body) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = body.getBoundingClientRect().height;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    let h = startH;
    const move = (ev: PointerEvent): void => {
      h = Math.max(60, startH + ev.clientY - startY);
      setDragHeight(h);
    };
    const up = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      setDragHeight(null);
      if (Math.abs(h - startH) > 2) props.onResize(h);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
  const empty = props.count === 0 && props.empty;
  return (
    <section
      className={`${styles.section} ${props.maximized ? styles.maximized : ''}`}
      aria-label={props.title}
      data-section={props.id}
    >
      <div className={styles.sectionHeaderRow} onContextMenu={props.onHeaderMenu}>
        <button
          type="button"
          className={styles.sectionHeader}
          aria-expanded={props.open}
          title="Click to collapse · double-click to maximize · right-click for options"
          onClick={props.onToggle}
          onDoubleClick={props.onMaximize}
        >
          {props.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {props.icon}
          <span className={styles.sectionTitle}>{props.title}</span>
          {props.maximized && <Maximize2 size={11} aria-label="maximized" />}
          {!props.hideCount && <span className={styles.count}>{props.count}</span>}
        </button>
        {props.action}
      </div>
      {props.open && (
        <div
          ref={bodyRef}
          className={`${styles.sectionBody} ${props.plain ? styles.plainBody : ''}`}
          style={
            dragHeight !== null
              ? { height: dragHeight, flex: 'none' }
              : props.plain && props.height && !props.maximized
                ? { height: props.height }
                : undefined
          }
          data-dragging={dragHeight !== null || undefined}
        >
          {empty ? <p className={styles.empty}>{props.empty}</p> : props.children}
        </div>
      )}
      {props.open && !props.maximized && !empty && (
        <div
          className={styles.resizeHandle}
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize ${props.title}`}
          title="Drag to resize"
          onPointerDown={startResize}
        />
      )}
    </section>
  );
}

function Highlighted({ text, hits, full }: { text: string; hits: readonly number[] | null; full?: string }) {
  if (!hits?.length) return <>{text}</>;
  return (
    <>
      {highlightSegments(text, hits, full ?? text).map((s, i) =>
        s.hit ? (
          <mark key={i} className={styles.hit}>
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

function RemoteHeaderRow({
  repoId,
  group,
  open,
  onToggle,
}: {
  repoId: RepoId;
  group: RemoteGroup;
  open: boolean;
  onToggle(): void;
}) {
  const showMenu = useContextMenu((s) => s.show);
  return (
    <div
      {...dropProps(repoId, { kind: 'remoteNode', remote: group.name }, styles.dropTarget)}
      role="treeitem"
      aria-expanded={open}
      tabIndex={0}
      className={`${styles.row} ${styles.remoteRow}`}
      style={{ paddingLeft: 12 }}
      title={
        group.remote
          ? `${group.remote.fetchUrl}${group.remote.pushUrl !== group.remote.fetchUrl ? `\npush: ${group.remote.pushUrl}` : ''}`
          : 'Not a configured remote'
      }
      onClick={onToggle}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggle()}
      onContextMenu={(e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, remoteMenu(repoId, group));
      }}
    >
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      <Cloud size={13} />
      <span className={styles.name}>{group.name}</span>
      {!group.refs.length && <span className={styles.track}>no branches</span>}
      {group.remote && (
        <button
          type="button"
          className={styles.rowAction}
          title={`Fetch ${group.name}`}
          aria-label={`Fetch ${group.name}`}
          onClick={(e) => {
            e.stopPropagation();
            fetchRemote(repoId, group.name);
          }}
        >
          <RefreshCw size={12} />
        </button>
      )}
    </div>
  );
}

function FolderRow(props: { name: string; depth: number; open: boolean; icon: ReactNode; onToggle(): void }) {
  return (
    <div
      role="treeitem"
      aria-expanded={props.open}
      tabIndex={0}
      className={styles.row}
      style={{ paddingLeft: 12 + props.depth * 14 }}
      onClick={props.onToggle}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && props.onToggle()}
    >
      {props.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      {props.icon}
      <span className={styles.name}>{props.name}</span>
    </div>
  );
}

function RefRow(props: {
  repoId: RepoId;
  r: RefInfo;
  label: string;
  depth: number;
  hits: readonly number[] | null;
  multi: boolean;
  allRefs: RefInfo[];
  onClick(r: RefInfo, e: MouseEvent): void;
  multiMenu(r: RefInfo): MenuEntry[] | null;
}) {
  const { repoId, r, label, depth } = props;
  const showMenu = useContextMenu((s) => s.show);
  const selected = useRepoUi(repoId, (u) => u.selection.kind === 'commit' && u.selection.sha === r.sha);
  const icon =
    r.type === 'tag' ? (
      <Tag size={13} />
    ) : r.isHead ? (
      <Check size={13} className={styles.head} />
    ) : (
      <GitBranch size={13} />
    );
  return (
    <div
      {...dragProps(refTarget(r))}
      {...dropProps(repoId, refTarget(r), styles.dropTarget)}
      role="treeitem"
      aria-selected={selected || props.multi}
      tabIndex={0}
      title={r.fullName + (r.upstream ? ` → ${r.upstream.fullName.replace(/^refs\/remotes\//, '')}` : '')}
      className={`${styles.row} ${r.isHead ? styles.current : ''} ${selected || props.multi ? styles.selected : ''}`}
      style={{ paddingLeft: 12 + depth * 14 + 13 }}
      onClick={(e) => props.onClick(r, e)}
      onKeyDown={(e) => e.key === 'Enter' && useRepoUiStore.getState().reveal(repoId, r.sha)}
      onContextMenu={(e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, props.multiMenu(r) ?? refMenu(repoId, r, props.allRefs));
      }}
      onDoubleClick={() => void checkout(repoId, checkoutTargetFor(r))}
    >
      {icon}
      <span className={styles.name}>
        <Highlighted text={label} hits={props.hits} full={r.shortName} />
      </span>
      {r.upstream && !r.upstream.gone && (r.upstream.ahead > 0 || r.upstream.behind > 0) && (
        <span className={styles.track} title={`${r.upstream.ahead} ahead, ${r.upstream.behind} behind`}>
          {r.upstream.ahead > 0 && `↑${r.upstream.ahead}`}
          {r.upstream.behind > 0 && ` ↓${r.upstream.behind}`}
        </span>
      )}
      {r.upstream?.gone && (
        <span className={styles.track} title="Upstream branch is gone">
          gone
        </span>
      )}
      <RefVisibilityToggle repoId={repoId} fullName={r.fullName} refs={props.allRefs} />
    </div>
  );
}

function StashRow({ repoId, stash, filter }: { repoId: RepoId; stash: StashEntry; filter: string }) {
  const select = useRepoUiStore((s) => s.update);
  const showMenu = useContextMenu((s) => s.show);
  const selected = useRepoUi(repoId, (u) => u.selection.kind === 'stash' && u.selection.sha === stash.sha);
  const choose = (): void =>
    select(repoId, () => ({
      selection: { kind: 'stash', sha: stash.sha, index: stash.index },
      center: { kind: 'graph' },
      reveal: { sha: stash.sha, nonce: Date.now() },
    }));
  return (
    <div
      {...dragProps({ kind: 'stash', sha: stash.sha, index: stash.index, message: stash.message })}
      role="treeitem"
      aria-selected={selected}
      tabIndex={0}
      className={`${styles.row} ${selected ? styles.selected : ''}`}
      style={{ paddingLeft: 25 }}
      title={stash.message}
      onClick={choose}
      onKeyDown={(e) => e.key === 'Enter' && choose()}
      onContextMenu={(e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, stashMenu(repoId, stash));
      }}
    >
      <Archive size={13} />
      <span className={styles.name}>
        <Highlighted text={stash.message} hits={filter ? fuzzyMatch(stash.message, filter) : null} />
      </span>
      <StashVisibilityToggle repoId={repoId} sha={stash.sha} />
    </div>
  );
}
