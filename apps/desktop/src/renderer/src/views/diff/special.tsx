import type { FileDiff, RepoId } from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { quiet, runOp } from '../../lib/ops';
import { shortSha } from '../../lib/format';
import { useRepoInfo } from '../../repo/queries';
import { useTabsStore } from '../../stores/tabs';
import { filesInvoke, INDEX, revisionUrl, WORKTREE } from '../file/files-api';
import { formatBytes, IMAGE_MAX_BYTES, sniffImage, type ImageMeta } from './image-meta';
import { HUGE_FILE_BYTES } from './large-file';
import styles from './DiffView.module.css';

/** CenterView revs (`''` absent, `WORKTREE`, `INDEX`, sha) → `githappens-rev://` / blob-info revs. */
export function protocolRev(rev: string): string | null {
  if (!rev) return null;
  if (rev === 'WORKTREE') return WORKTREE;
  if (rev === 'INDEX') return INDEX;
  return rev;
}

export function Banner({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return (
    <div className={`${styles.banner} ${tone === 'warn' ? styles.bannerWarn : ''}`} role="status">
      {children}
    </div>
  );
}

/** Rename/copy, mode and type-change banners (spec 07 §4.7). */
export function FileBanners({ file }: { file: FileDiff }) {
  const out: ReactNode[] = [];
  if ((file.status === 'R' || file.status === 'C') && file.oldPath) {
    out.push(
      <Banner key="rename">
        {file.status === 'R' ? 'Renamed' : 'Copied'} from <code>{file.oldPath}</code>
        {file.similarity !== undefined && ` (similarity ${file.similarity}%)`}
      </Banner>,
    );
  }
  if (file.status === 'T') {
    const kind = (m?: string): string => (m === '120000' ? 'symlink' : m === '160000' ? 'submodule' : 'file');
    out.push(
      <Banner key="type">
        Changed from {kind(file.oldMode)} to {kind(file.newMode)}
      </Banner>,
    );
  } else if (file.oldMode && file.newMode && file.oldMode !== file.newMode) {
    out.push(
      <Banner key="mode">
        File mode changed <code>{file.oldMode}</code> → <code>{file.newMode}</code>
      </Banner>,
    );
  }
  return <>{out}</>;
}

// ---- image diff (spec 07 §4.6) ----

type ImageMode = 'side' | 'swipe' | 'onion' | 'difference';

interface Loaded {
  url: string;
  meta: ImageMeta | null;
  size: number;
}

async function loadImage(url: string): Promise<Loaded | 'too-large' | null> {
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (r.status === 413) return 'too-large';
  if (!r.ok) throw new Error(`Could not load image (${r.status})`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { url, meta: sniffImage(bytes), size: bytes.length };
}

export function ImageDiff(props: {
  repoId: RepoId;
  oldRev: string;
  newRev: string;
  oldPath: string;
  path: string;
}) {
  const [mode, setMode] = useState<ImageMode>('side');
  const [pos, setPos] = useState(50);
  const oldRev = protocolRev(props.oldRev);
  const newRev = protocolRev(props.newRev);
  const q = useQuery({
    queryKey: ['diff', props.repoId, 'image', oldRev, newRev, props.oldPath, props.path],
    queryFn: async () =>
      Promise.all([
        oldRev ? loadImage(revisionUrl(props.repoId, oldRev, props.oldPath)) : null,
        newRev ? loadImage(revisionUrl(props.repoId, newRev, props.path)) : null,
      ]),
  });
  if (q.isLoading) return <p className={styles.message}>Loading images…</p>;
  if (q.error) return <p className={styles.message}>{(q.error as Error).message}</p>;
  const [before, after] = q.data ?? [null, null];
  if (before === 'too-large' || after === 'too-large') {
    return <p className={styles.message}>Image larger than {formatBytes(IMAGE_MAX_BYTES)} — not rendered.</p>;
  }
  const both = !!before && !!after;
  const dims = (l: Loaded): string =>
    `${l.meta?.width && l.meta.height ? `${l.meta.width} × ${l.meta.height} · ` : ''}${formatBytes(l.size)}`;

  return (
    <div className={styles.imageDiff}>
      {both && (
        <div className={styles.segmented} role="group" aria-label="Image compare mode">
          {(
            [
              ['side', 'Side by side'],
              ['swipe', 'Swipe'],
              ['onion', 'Onion skin'],
              ['difference', 'Difference'],
            ] as const
          ).map(([m, label]) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
              {label}
            </button>
          ))}
          {(mode === 'swipe' || mode === 'onion') && (
            <input
              type="range"
              min={0}
              max={100}
              value={pos}
              aria-label={mode === 'swipe' ? 'Swipe position' : 'Opacity of the new image'}
              onChange={(e) => setPos(Number(e.target.value))}
            />
          )}
        </div>
      )}
      {(!both || mode === 'side') && (
        <div className={styles.images}>
          {(
            [
              ['Before', before],
              ['After', after],
            ] as const
          ).map(([label, img]) => (
            <figure key={label}>
              <figcaption>
                {label}
                {img ? ` · ${dims(img)}` : ''}
              </figcaption>
              {img ? (
                <img className={styles.checker} src={img.url} alt={`${label}: ${props.path}`} />
              ) : (
                <div className={styles.message}>{label === 'Before' ? '(added)' : '(deleted)'}</div>
              )}
            </figure>
          ))}
        </div>
      )}
      {both && mode !== 'side' && mode !== 'difference' && (
        <div className={styles.overlayWrap}>
          <figcaption>
            Before · {dims(before)} — After · {dims(after)}
          </figcaption>
          <div className={`${styles.overlay} ${styles.checker}`}>
            <img src={before.url} alt={`Before: ${props.path}`} />
            <img
              src={after.url}
              alt={`After: ${props.path}`}
              className={styles.overlayTop}
              style={mode === 'swipe' ? { clipPath: `inset(0 0 0 ${pos}%)` } : { opacity: pos / 100 }}
            />
            {mode === 'swipe' && <div className={styles.swipeLine} style={{ left: `${pos}%` }} />}
          </div>
        </div>
      )}
      {both && mode === 'difference' && <DifferenceCanvas before={before.url} after={after.url} />}
    </div>
  );
}

/** Pixel difference (`difference` compositing): unchanged pixels render black. */
function DifferenceCanvas({ before, after }: { before: string; after: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = (src: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Could not decode the image.'));
        img.src = src;
      });
    Promise.all([load(before), load(after)])
      .then(([a, b]) => {
        const c = ref.current;
        if (cancelled || !c) return;
        c.width = Math.max(a.naturalWidth, b.naturalWidth);
        c.height = Math.max(a.naturalHeight, b.naturalHeight);
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(a, 0, 0);
        ctx.globalCompositeOperation = 'difference';
        ctx.drawImage(b, 0, 0);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [before, after]);
  if (error) return <p className={styles.message}>{error}</p>;
  return (
    <div className={styles.overlayWrap}>
      <figcaption>Difference (identical pixels are black)</figcaption>
      <canvas ref={ref} className={styles.diffCanvas} />
    </div>
  );
}

// ---- binary (spec 07 §4.7) ----

function useBlobSizes(repoId: RepoId, oldRev: string, newRev: string, oldPath: string, path: string) {
  const o = protocolRev(oldRev);
  const n = protocolRev(newRev);
  return useQuery({
    queryKey: ['diff', repoId, 'blobInfo', o, n, oldPath, path],
    queryFn: () =>
      Promise.all([
        o ? filesInvoke('diff:blobInfo', { repoId, rev: o, path: oldPath }) : null,
        n ? filesInvoke('diff:blobInfo', { repoId, rev: n, path }) : null,
      ]),
  });
}

export function BinaryCard(props: {
  repoId: RepoId;
  oldRev: string;
  newRev: string;
  oldPath: string;
  path: string;
  note?: string;
}) {
  const sizes = useBlobSizes(props.repoId, props.oldRev, props.newRev, props.oldPath, props.path);
  const [a, b] = sizes.data ?? [null, null];
  const fmt = (x: typeof a): string => (x?.exists ? formatBytes(x.size) : '∅');
  return (
    <div className={styles.card}>
      <strong>Binary file changed</strong>
      <span>
        {sizes.isLoading ? 'Reading sizes…' : `${fmt(a)} → ${fmt(b)}`}
        {(a?.size ?? 0) > HUGE_FILE_BYTES || (b?.size ?? 0) > HUGE_FILE_BYTES
          ? ' · too large to display'
          : ''}
      </span>
      {props.note && <span className={styles.muted}>{props.note}</span>}
    </div>
  );
}

// ---- LFS (spec 07 §4.7) ----

export function LfsBanner(props: {
  repoId: RepoId;
  oldRev: string;
  newRev: string;
  oldPath: string;
  path: string;
  /** Called with whether every present side is available locally. */
  children(available: boolean): ReactNode;
}) {
  const info = useBlobSizes(props.repoId, props.oldRev, props.newRev, props.oldPath, props.path);
  const [fetching, setFetching] = useState(false);
  const [a, b] = info.data ?? [null, null];
  const sides = [a, b].filter((x) => x?.exists);
  const available = sides.length > 0 && sides.every((x) => !x?.lfs || x.lfs.available);
  const oid = (x: typeof a): string => (x?.lfs ? `${x.lfs.oid.slice(0, 8)}…` : '∅');
  const size = (x: typeof a): string => (x?.exists ? formatBytes(x.lfs?.size ?? x.size) : '∅');
  return (
    <>
      <Banner>
        Git LFS file · oid {oid(a)} → {oid(b)} · {size(a)} → {size(b)}
        {!info.isLoading && !available && (
          <>
            {' · '}
            <button
              type="button"
              disabled={fetching}
              onClick={() => {
                setFetching(true);
                quiet(
                  runOp(props.repoId, { type: 'lfs.fetch' }, { successToast: 'Fetched LFS objects' }).finally(
                    () => {
                      setFetching(false);
                      void info.refetch();
                    },
                  ),
                );
              }}
            >
              {fetching ? 'Fetching…' : 'Fetch LFS object'}
            </button>
          </>
        )}
      </Banner>
      {!info.isLoading && props.children(available)}
    </>
  );
}

/** Text of both sides through `githappens-rev://` (resolves LFS objects that are available locally). */
export function useProtocolText(
  repoId: RepoId,
  oldRev: string,
  newRev: string,
  oldPath: string,
  path: string,
  enabled: boolean,
) {
  const o = protocolRev(oldRev);
  const n = protocolRev(newRev);
  return useQuery({
    queryKey: ['diff', repoId, 'protocolText', o, n, oldPath, path],
    enabled,
    queryFn: async () => {
      const get = async (rev: string | null, p: string): Promise<string> => {
        if (!rev) return '';
        const r = await fetch(revisionUrl(repoId, rev, p));
        if (r.status === 404) return '';
        if (!r.ok) throw new Error(`Could not load ${p} (${r.status})`);
        return r.text();
      };
      return Promise.all([get(o, oldPath), get(n, path)]);
    },
  });
}

// ---- submodule (spec 07 §4.7) ----

export function SubmoduleDiff({ repoId, file }: { repoId: RepoId; file: FileDiff }) {
  const path = file.newPath ?? file.oldPath ?? '';
  const from = file.submodule?.oldSha;
  const to = file.submodule?.newSha;
  const info = useRepoInfo(repoId);
  const log = useQuery({
    queryKey: ['diff', repoId, 'submoduleLog', path, from, to],
    queryFn: () =>
      filesInvoke('diff:submoduleLog', {
        repoId,
        path,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      }),
  });
  const l = log.data;
  const direction =
    l && l.initialized && !l.unavailable
      ? l.behind > 0 && l.ahead === 0
        ? ` (rewound ${l.behind} commit${l.behind === 1 ? '' : 's'})`
        : l.ahead > 0
          ? ` (+${l.ahead} commit${l.ahead === 1 ? '' : 's'}${l.behind ? `, −${l.behind}` : ''})`
          : ''
      : '';
  const root = info.data?.worktreeRoot;
  return (
    <div className={styles.submodule}>
      <Banner>
        Submodule <code>{path}</code> {!from ? 'added at' : !to ? 'removed from' : 'updated'}{' '}
        <code>{from ? shortSha(from) : ''}</code>
        {from && to ? ' → ' : ''}
        <code>{to ? shortSha(to) : ''}</code>
        {direction}
        {root && l?.initialized && (
          <>
            {' · '}
            <button
              type="button"
              onClick={() => void useTabsStore.getState().openRepo(`${root.replace(/[\\/]+$/, '')}/${path}`)}
            >
              Open submodule
            </button>
          </>
        )}
      </Banner>
      {log.isLoading && <p className={styles.message}>Loading submodule commits…</p>}
      {l && !l.initialized && (
        <p className={styles.message}>The submodule is not initialized; no commit list.</p>
      )}
      {l?.unavailable && (
        <p className={styles.message}>The submodule does not have these commits locally (fetch it first).</p>
      )}
      {l && l.commits.length > 0 && (
        <ul className={styles.commitList}>
          {l.commits.map((c) => (
            <li key={c.sha}>
              <code>{shortSha(c.sha)}</code> {c.subject}
            </li>
          ))}
          {l.ahead + l.behind > l.commits.length && <li className={styles.muted}>… (showing first 100)</li>}
        </ul>
      )}
    </div>
  );
}

// ---- large files (spec 07 §4.14) ----

export function LargeFileGuard(props: { bytes: number; lines?: number; onLoad(): void }) {
  return (
    <div className={styles.card}>
      <strong>
        This file is large ({formatBytes(props.bytes)}
        {props.lines ? `, ${props.lines.toLocaleString()} lines` : ''}). The diff may be slow.
      </strong>
      <span>
        <button type="button" className="primary" onClick={props.onLoad}>
          Load diff
        </button>
      </span>
    </div>
  );
}
