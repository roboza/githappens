import type { CommitDetail, DiffSpec, RepoId } from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, Copy, GitCompare } from 'lucide-react';
import { useMemo, useState } from 'react';

import { fileMenu } from '../../actions/menus';
import { commitDiffContext } from '../../tools/menus';
import { openCompose, openExplain } from '../../ai/actions';
import { useAiEnabled } from '../../ai/hooks';
import { Avatar } from '../../components/Avatar';
import { useContextMenu } from '../../components/ContextMenu';
import { invoke } from '../../lib/api';
import { DateText } from '../../components/DateText';
import { fullDate, shortSha } from '../../lib/format';
import { qk, useCommitDetail, useRepoInfo } from '../../repo/queries';
import { useSetting } from '../../stores/settings';
import { useRepoUi, useRepoUiStore, type CenterView } from '../../stores/repo-ui';
import { FileList, type FileEntry } from './FileList';
import { compareRefs, compareWithWorkingDir, contiguousRange, rangeSpec } from '../diff/compare';
import { filesInvoke } from '../file/files-api';
import { ExplainPanel } from '../ai/ExplainPanel';
import { openChangelog } from '../ai/ChangelogDialog';
import { SparkleButton } from '../ai/SparkleButton';
import { stashFileApplyItem } from '../ops/branching-actions';
import { StagingPanel } from './StagingPanel';
import styles from './RightPanel.module.css';

/** Selection-driven right panel (spec 01 §4.6, spec 07 commit detail). */
export function RightPanel({ repoId }: { repoId: RepoId }) {
  const selection = useRepoUi(repoId, (u) => u.selection);
  const explain = useRepoUi(repoId, (u) => u.explain);
  const ai = useAiEnabled();
  // AI Explain (spec 12 §4.4) is shown over the selection panel until closed or the selection changes.
  if (ai && explain) return <ExplainPanel repoId={repoId} target={explain.target} nonce={explain.nonce} />;
  switch (selection.kind) {
    case 'commit':
      return <CommitPanel repoId={repoId} sha={selection.sha} />;
    case 'stash':
      return <CommitPanel repoId={repoId} sha={selection.sha} stashIndex={selection.index} />;
    case 'wip':
      return <StagingPanel repoId={repoId} />;
    case 'commits':
      return <MultiPanel repoId={repoId} shas={selection.shas} />;
    default:
      return <p className={styles.placeholder}>Select a commit to see its details.</p>;
  }
}

function useOpenDiff(repoId: RepoId) {
  const update = useRepoUiStore((s) => s.update);
  return (center: CenterView) => update(repoId, () => ({ center }));
}

function CommitPanel({ repoId, sha, stashIndex }: { repoId: RepoId; sha: string; stashIndex?: number }) {
  const detail = useCommitDetail(repoId, sha);
  const dateFormat = useSetting('ui.dateFormat');
  const reveal = useRepoUiStore((s) => s.reveal);
  const ai = useAiEnabled();

  if (detail.isLoading) return <p className={styles.placeholder}>Loading…</p>;
  if (detail.error || !detail.data)
    return <p className={styles.placeholder}>Could not load commit {shortSha(sha)}.</p>;
  const c: CommitDetail = detail.data;
  const differentCommitter =
    c.committerEmail !== c.authorEmail || c.committerName !== c.authorName || c.commitTime !== c.authorTime;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.shaRow}>
          <span className={styles.label}>
            {stashIndex !== undefined ? `stash@{${stashIndex}}` : 'commit'}
          </span>
          <button
            type="button"
            className={styles.sha}
            title="Copy SHA"
            onClick={() => void invoke('shell:copyText', { text: c.sha })}
          >
            {shortSha(c.sha)} <Copy size={12} />
          </button>
          {c.parents.length > 0 && (
            <span className={styles.label}>parent{c.parents.length > 1 ? 's' : ''}</span>
          )}
          {c.parents.map((p) => (
            <button
              key={p}
              type="button"
              className={styles.link}
              title="Select in graph (Shift+click: compare with this parent)"
              onClick={(e) =>
                e.shiftKey ? compareRefs(repoId, p, c.sha, { threeDot: false }) : reveal(repoId, p)
              }
            >
              {shortSha(p)}
            </button>
          ))}
          {c.parents.length === 0 && <span className={styles.label}>Initial commit</span>}
          {stashIndex === undefined && <SignatureBadge repoId={repoId} sha={c.sha} />}
          {ai && stashIndex === undefined && (
            <SparkleButton
              label="Explain this commit with AI"
              text="Explain"
              onRun={() => openExplain(repoId, { kind: 'commits', shas: [c.sha] })}
            />
          )}
          {stashIndex === undefined && (
            <button
              type="button"
              className={styles.link}
              title="Compare this commit with the working directory"
              onClick={() => compareWithWorkingDir(repoId, c.sha)}
            >
              <GitCompare size={12} /> vs WIP
            </button>
          )}
        </div>
        <h2 className={styles.subject}>{c.subject}</h2>
        {c.body.trim() && <CommitBody text={c.body.trim()} />}
        <div className={styles.person}>
          <Avatar name={c.authorName} email={c.authorEmail} size={28} />
          <div>
            <div className={styles.personName} title={c.authorEmail}>
              {c.authorName}
            </div>
            <div className={styles.personMeta} title={fullDate(c.authorTime)}>
              authored <DateText unixSeconds={c.authorTime} format={dateFormat} />
            </div>
          </div>
        </div>
        {differentCommitter && (
          <div className={styles.person}>
            <Avatar name={c.committerName} email={c.committerEmail} size={22} />
            <div className={styles.personMeta} title={`${c.committerEmail} · ${fullDate(c.commitTime)}`}>
              committed by {c.committerName} <DateText unixSeconds={c.commitTime} format={dateFormat} />
            </div>
          </div>
        )}
      </div>
      <CommitFiles repoId={repoId} commit={c} stashIndex={stashIndex} />
    </div>
  );
}

const BODY_LINES = 12;

/** Long bodies collapse after 12 lines with "Show more" (spec 07 §4.2). */
function CommitBody({ text }: { text: string }) {
  const lines = text.split('\n');
  const [open, setOpen] = useState(false);
  const long = lines.length > BODY_LINES;
  return (
    <div>
      <pre className={styles.body}>{long && !open ? lines.slice(0, BODY_LINES).join('\n') : text}</pre>
      {long && (
        <button type="button" className={styles.link} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `Show more (${lines.length - BODY_LINES} more lines)`}
        </button>
      )}
    </div>
  );
}

/**
 * Changed files of a commit (spec 07 §4.2): parent selector for merges (parent N or combined `--cc`),
 * "View all files", filter, counts and keyboard navigation through `FileList`.
 */
function CommitFiles({
  repoId,
  commit: c,
  stashIndex,
}: {
  repoId: RepoId;
  commit: CommitDetail;
  stashIndex?: number;
}) {
  const openDiff = useOpenDiff(repoId);
  const activePath = useRepoUi(repoId, (u) => (u.center.kind === 'diff' ? u.center.path : undefined));
  const showMenu = useContextMenu((s) => s.show);
  const [parentIndex, setParentIndex] = useState<number | 'combined'>(1);
  const [viewAll, setViewAll] = useState(false);
  const merge = c.parents.length > 1;
  const parent = typeof parentIndex === 'number' ? c.parents[parentIndex - 1] : c.parents[0];

  const otherParent = useQuery({
    queryKey: qk.numstat(repoId, `${c.sha}^${parentIndex}`),
    queryFn: () =>
      invoke('git:diff:numstat', {
        repoId,
        spec: { kind: 'commit', sha: c.sha, parentIndex: parentIndex as number },
      }),
    enabled: merge && typeof parentIndex === 'number' && parentIndex > 1,
  });
  const combined = useQuery({
    queryKey: ['diff', repoId, 'combined', c.sha, ''],
    queryFn: () => filesInvoke('diff:combined', { repoId, sha: c.sha }),
    enabled: merge && parentIndex === 'combined',
  });
  const allFiles = useQuery({
    queryKey: ['allFiles', repoId, c.sha],
    queryFn: () => filesInvoke('diff:allFiles', { repoId, rev: c.sha }),
    enabled: viewAll,
    staleTime: Infinity,
  });

  const changed: FileEntry[] = useMemo(() => {
    if (parentIndex === 'combined')
      return (combined.data ?? []).map((f) => ({ path: f.path, status: 'M' as const }));
    if (parentIndex !== 1) return (otherParent.data ?? []).map((f) => ({ ...f }));
    return c.files.map((f) => ({ ...f }));
  }, [parentIndex, combined.data, otherParent.data, c.files]);
  const files: FileEntry[] = useMemo(() => {
    if (!viewAll || !allFiles.data) return changed;
    const byPath = new Map(changed.map((f) => [f.path, f]));
    const rest = allFiles.data
      .filter((p) => !byPath.has(p))
      .map((p) => ({ path: p, status: 'M' as const, unchanged: true }));
    return [...changed, ...rest].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  }, [changed, viewAll, allFiles.data]);
  const loading = (parentIndex === 'combined' && combined.isLoading) || otherParent.isLoading;

  const open = (f: FileEntry): void => {
    if (f.unchanged) {
      // an unchanged file of the tree: show it at this revision (read-only)
      useRepoUiStore
        .getState()
        .update(repoId, () => ({ center: { kind: 'file', path: f.path, mode: 'edit', rev: c.sha } }));
      return;
    }
    openDiff({
      kind: 'diff',
      spec: {
        kind: 'commit',
        sha: c.sha,
        // parentIndex 0 = combined view (`--cc`), handled by the diff view
        ...(parentIndex === 'combined' ? { parentIndex: 0 } : parentIndex > 1 ? { parentIndex } : {}),
        paths: f.oldPath ? [f.oldPath, f.path] : [f.path],
      },
      path: f.path,
      oldPath: f.oldPath,
      title: `${shortSha(c.sha)} · ${f.path}`,
      oldRev: f.status === 'A' || !parent ? '' : parent,
      newRev: f.status === 'D' ? '' : c.sha,
    });
  };

  return (
    <>
      {merge && (
        <div className={styles.parentBar}>
          <span className={styles.label}>Merge: {c.parents.length} parents · changes vs</span>
          <select
            aria-label="Changes against parent"
            value={String(parentIndex)}
            onChange={(e) =>
              setParentIndex(e.target.value === 'combined' ? 'combined' : Number(e.target.value))
            }
          >
            {c.parents.map((p, i) => (
              <option key={p} value={i + 1}>
                parent {i + 1} ({shortSha(p)}){i === 0 ? ' — default' : ''}
              </option>
            ))}
            <option value="combined">combined (--cc)</option>
          </select>
        </div>
      )}
      {parentIndex === 'combined' && combined.data?.length === 0 && (
        <p className={styles.parentNote}>No conflicts were resolved in this merge (no combined changes).</p>
      )}
      {loading ? (
        <p className={styles.placeholder}>Loading files…</p>
      ) : (
        <FileList
          onMenu={(f, x, y) => {
            if (f.unchanged) return;
            const items = fileMenu(repoId, f.path, false, commitDiffContext(f, c.sha, parent));
            // a file of a selected stash: "Apply this file from stash" (spec 05 §4.9)
            if (stashIndex !== undefined && f.status !== 'D') {
              items.unshift(
                stashFileApplyItem(repoId, { index: stashIndex, sha: c.sha }, f.path),
                'separator',
              );
            }
            showMenu(x, y, items);
          }}
          viewKey="commit"
          files={files}
          activePath={activePath}
          onOpen={open}
          toolbar
          navRepoId={repoId}
          viewAll={{ checked: viewAll, loading: viewAll && allFiles.isLoading, onChange: setViewAll }}
        />
      )}
    </>
  );
}

/** Oldest → newest when the selection forms one first-parent chain (spec 07 §2.1). */
async function contiguous(
  repoId: RepoId,
  shas: string[],
): Promise<{ order: string[]; oldestParent?: string } | null> {
  const details = await Promise.all(shas.map((sha) => invoke('git:commit:detail', { repoId, sha })));
  const order = contiguousRange(details);
  if (!order) return null;
  const oldest = details.find((d) => d.sha === order[0])!;
  return { order, ...(oldest.parents[0] ? { oldestParent: oldest.parents[0] } : {}) };
}

type RangeSpec = Extract<DiffSpec, { kind: 'range' }>;

function MultiPanel({ repoId, shas }: { repoId: RepoId; shas: string[] }) {
  const openDiff = useOpenDiff(repoId);
  const ai = useAiEnabled();
  const info = useRepoInfo(repoId);
  const aiActions = ai ? <MultiAiActions repoId={repoId} shas={shas} /> : null;
  const [swapped, setSwapped] = useState(false);
  const range = useQuery({
    queryKey: ['contiguous', repoId, ...shas],
    queryFn: () => contiguous(repoId, shas),
    enabled: shas.length > 2,
  });
  // two commits: compare them (older by row → newer); a contiguous range: combined `oldest^..newest`
  let spec: RangeSpec | null = null;
  let heading = '';
  if (shas.length === 2) {
    const [a, b] = swapped ? [shas[0]!, shas[1]!] : [shas[1]!, shas[0]!];
    spec = { kind: 'range', from: a, to: b };
    heading = `Comparing ${shortSha(a)} ↔ ${shortSha(b)}`;
  } else if (range.data) {
    const newest = range.data.order.at(-1)!;
    spec = rangeSpec(range.data.oldestParent, newest, info.data?.objectFormat ?? 'sha1') as RangeSpec;
    heading = `${shas.length} commits combined (${shortSha(range.data.order[0]!)}^ → ${shortSha(newest)})`;
  }
  const files = useQuery({
    queryKey: qk.numstat(repoId, JSON.stringify(spec)),
    queryFn: () => invoke('git:diff:numstat', { repoId, spec: spec! }),
    enabled: !!spec,
  });
  if (!spec) {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>
          <h2 className={styles.subject}>{shas.length} commits selected</h2>
          <p className={styles.note}>
            {range.isLoading
              ? 'Checking the selection…'
              : 'Select two commits to compare them, or a contiguous range of commits to see their combined changes.'}
          </p>
          {aiActions}
        </div>
      </div>
    );
  }
  const s = spec;
  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <h2 className={styles.subject}>{heading}</h2>
        <div className={styles.shaRow}>
          {shas.length === 2 && (
            <button
              type="button"
              className={styles.link}
              onClick={() => setSwapped(!swapped)}
              title="Swap sides"
            >
              <ArrowLeftRight size={12} /> Swap
            </button>
          )}
          <button
            type="button"
            className={styles.link}
            title="Open the comparison in the center area (two-dot / three-dot, swap)"
            onClick={() => compareRefs(repoId, s.from, s.to, { threeDot: false })}
          >
            <GitCompare size={12} /> Open comparison
          </button>
        </div>
        {aiActions}
      </div>
      {files.data && (
        <FileList
          viewKey="compare"
          files={files.data}
          toolbar
          navRepoId={repoId}
          onOpen={(f) =>
            openDiff({
              kind: 'diff',
              spec: { ...s, paths: f.oldPath ? [f.oldPath, f.path] : [f.path] },
              path: f.path,
              oldPath: f.oldPath,
              title: `${shortSha(s.from)}..${shortSha(s.to)} · ${f.path}`,
              oldRev: f.status === 'A' ? '' : s.from,
              newRev: f.status === 'D' ? '' : s.to,
            })
          }
        />
      )}
    </div>
  );
}

/**
 * AI actions for a multi-selection (spec 12 §4.4): explain the commits, recompose them (the op checks that
 * they form a contiguous range ending at HEAD), or write a changelog for the range.
 */
function MultiAiActions({ repoId, shas }: { repoId: RepoId; shas: string[] }) {
  const info = useQuery({
    queryKey: ['ai', 'multi-order', repoId, ...shas],
    queryFn: () => orderByAncestry(repoId, shas),
  });
  const ordered = info.data;
  return (
    <div className={styles.shaRow}>
      <SparkleButton
        label={`Explain ${shas.length} commits with AI`}
        text="Explain"
        onRun={() => openExplain(repoId, { kind: 'commits', shas: ordered ?? shas })}
      />
      <SparkleButton
        label={`Recompose ${shas.length} commits with AI`}
        text={`Recompose ${shas.length} commits`}
        title="Split the combined changes into new commits (the newest selected commit must be HEAD)"
        disabled={!ordered}
        onRun={() =>
          ordered && openCompose(repoId, { kind: 'range', from: ordered[0]!, to: ordered.at(-1)! })
        }
      />
      {shas.length === 2 && (
        <SparkleButton
          label="Generate changelog for this range"
          text="Changelog"
          disabled={!ordered}
          onRun={() => ordered && openChangelog(repoId, { from: `${ordered[0]!}^`, to: ordered[1]! })}
        />
      )}
    </div>
  );
}

/** Oldest first, using commit times (good enough for a selection on one line of history). */
async function orderByAncestry(repoId: RepoId, shas: string[]): Promise<string[]> {
  const details = await Promise.all(shas.map((sha) => invoke('git:commit:detail', { repoId, sha })));
  return details.sort((x, y) => x.commitTime - y.commitTime).map((d) => d.sha);
}

const SIGNATURE_TEXT: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' }> = {
  G: { label: 'Verified', tone: 'good' },
  U: { label: 'Signed (unknown key)', tone: 'warn' },
  E: { label: "Signed (can't verify)", tone: 'warn' },
  X: { label: 'Signature expired', tone: 'warn' },
  Y: { label: 'Key expired', tone: 'warn' },
  R: { label: 'Key revoked', tone: 'bad' },
  B: { label: 'Bad signature', tone: 'bad' },
};

/** "Verified" badge from `git:commit:verify` (spec 06 §6.8). Unsigned commits show nothing. */
function SignatureBadge({ repoId, sha }: { repoId: RepoId; sha: string }) {
  const sig = useQuery({
    queryKey: ['signature', repoId, sha],
    queryFn: () => invoke('git:commit:verify', { repoId, shas: [sha] }),
    staleTime: Infinity,
  });
  const info = sig.data?.[sha];
  const t = info ? SIGNATURE_TEXT[info.code] : undefined;
  if (!info || !t) return null;
  return (
    <span
      className={`${styles.sigBadge} ${styles[t.tone]}`}
      title={[info.signer, info.format?.toUpperCase(), info.key].filter(Boolean).join(' · ')}
    >
      {t.label}
    </span>
  );
}
