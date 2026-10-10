import type { RepoId } from '@githappens/git/types';
import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';

import { Splitter } from '../components/Splitter';
import { refreshScopes, useRepoInfo } from '../repo/queries';
import { useSession, useSessionStore } from '../repo/sessions';
import { isMissingRepoError, MissingRepo } from '../shell/MissingRepo';
import { fitPanels, LEFT_MIN, RIGHT_MIN } from '../shell/panel-fit';
import { Toolbar } from '../shell/Toolbar';
import { useLayoutStore } from '../stores/layout';
import { useRepoUi, useRepoUiStore } from '../stores/repo-ui';
import { GraphView } from './graph/GraphView';
import { LeftPanel } from './left/LeftPanel';
import { OperationBanner } from './merge/OperationBanner';
import { RightPanel } from './right/RightPanel';
import { TerminalPanel } from './terminal/TerminalPanel';
import styles from './RepoView.module.css';

const DiffView = lazy(() => import('./diff/DiffView'));
const FileView = lazy(() => import('./file/FileView'));
const MergeToolView = lazy(() => import('./merge/MergeToolView'));
const InteractiveRebaseView = lazy(() => import('./rebase/InteractiveRebaseView'));
const PullRequestView = lazy(() => import('./pr/PullRequestView'));
const CommitComposerView = lazy(() => import('./ai/CommitComposerView'));
const CloudPatchView = lazy(() => import('./cloud-patches/CloudPatchView'));

/** Opens (or reuses) the repo session for a tab and renders the repo workspace. */
export function RepoTab({ path }: { path: string }) {
  const session = useSession(path);
  const ensure = useSessionStore((s) => s.ensure);
  useEffect(() => ensure(path), [ensure, path]);

  if (!session || session.state === 'opening')
    return <div className={styles.center}>Opening repository…</div>;
  if (session.state === 'error') {
    // Moved / deleted repository: "Repository not found" with Locate… / Remove (spec 01 §8).
    if (isMissingRepoError(session.code, session.message))
      return <MissingRepo path={path} message={session.message} />;
    return (
      <div className={styles.center} role="alert">
        <p>Could not open {path}</p>
        <p className={styles.muted}>{session.message}</p>
        <button type="button" onClick={() => ensure(path)}>
          Retry
        </button>
      </div>
    );
  }
  return <RepoWorkspace repoId={session.repoId} />;
}

function RepoWorkspace({ repoId }: { repoId: RepoId }) {
  const qc = useQueryClient();
  const info = useRepoInfo(repoId);
  const center = useRepoUi(repoId, (u) => u.center);
  const layout = useLayoutStore();
  // Once the terminal has been opened in this tab keep it mounted (hidden) so shells keep running.
  const [terminalEverOpened, setTerminalEverOpened] = useState(layout.terminalOpen);
  if (layout.terminalOpen && !terminalEverOpened) setTerminalEverOpened(true);
  // Rendered panel widths fit the workspace width so the center is never overlapped (spec 01 §4.6).
  const mainRef = useRef<HTMLDivElement>(null);
  const hasInfo = !!info.data;
  const [mainWidth, setMainWidth] = useState(0);
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setMainWidth(el.clientWidth));
    ro.observe(el);
    setMainWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [hasInfo]);
  const fit = fitPanels({
    width: mainWidth,
    left: layout.leftPanelWidth,
    leftCollapsed: layout.leftPanelCollapsed,
    right: layout.rightPanelWidth,
    rightCollapsed: layout.rightPanelCollapsed,
  });

  // Focus refresh (spec 02 §6.14): cheap status + refs re-read when the window regains focus.
  useEffect(() => {
    let last = Date.now();
    const onFocus = (): void => {
      if (Date.now() - last < 2000) return;
      last = Date.now();
      refreshScopes(qc, repoId, ['status', 'refs']);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [qc, repoId]);

  // Esc closes an open diff or file view (editor and merge tool keep Esc for themselves).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const c = useRepoUiStore.getState().get(repoId).center;
      if (e.key === 'Escape' && (c.kind === 'diff' || (c.kind === 'file' && c.mode !== 'edit'))) {
        useRepoUiStore.getState().update(repoId, () => ({ center: { kind: 'graph' } }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [repoId]);

  if (!info.data) return <div className={styles.center}>Loading…</div>;
  const terminalMounted = layout.terminalOpen || terminalEverOpened;

  const focusSearch = (): void => {
    window.dispatchEvent(new CustomEvent('kl:focus-graph-search'));
  };

  return (
    <div className={styles.workspace}>
      <Toolbar repoId={repoId} info={info.data} onSearch={focusSearch} />
      <div ref={mainRef} className={styles.main}>
        {!fit.leftHidden && (
          <>
            <div className={styles.left} style={{ width: fit.left }} data-focus-zone="left">
              <LeftPanel repoId={repoId} />
            </div>
            <Splitter
              label="Resize left panel"
              size={fit.left}
              min={LEFT_MIN}
              max={fit.leftMax}
              direction={1}
              onResize={(w) => layout.patch({ leftPanelWidth: w })}
            />
          </>
        )}
        <div className={styles.centerArea} data-focus-zone="center">
          <OperationBanner repoId={repoId} />
          {/* Keep the graph mounted under the diff so scroll position and loaded history survive. */}
          <div className={styles.fill} hidden={center.kind !== 'graph'}>
            <GraphView repoId={repoId} info={info.data} />
          </div>
          <Suspense fallback={<div className={styles.center}>Loading…</div>}>
            {center.kind === 'diff' && <DiffView repoId={repoId} view={center} />}
            {center.kind === 'file' && <FileView key={center.path} repoId={repoId} view={center} />}
            {center.kind === 'merge' && (
              <MergeToolView key={center.path} repoId={repoId} path={center.path} />
            )}
            {center.kind === 'rebase' && (
              <InteractiveRebaseView
                repoId={repoId}
                upstream={center.upstream}
                onto={center.onto}
                label={center.label}
              />
            )}
            {center.kind === 'pr' && (
              <PullRequestView
                key={`${center.ref.owner}/${center.ref.name}#${center.number}`}
                repoId={repoId}
                repoRef={center.ref}
                number={center.number}
              />
            )}
            {center.kind === 'compose' && (
              <CommitComposerView
                key={center.source.kind === 'range' ? `${center.source.from}..${center.source.to}` : 'staged'}
                repoId={repoId}
                source={center.source}
              />
            )}
            {center.kind === 'patch' && (
              <CloudPatchView key={center.patchId} repoId={repoId} patchId={center.patchId} />
            )}
          </Suspense>
          {/* Bottom dock (spec 01 §4.1 BottomDock): mounted once opened so shells survive hiding. */}
          {terminalMounted && info.data.worktreeRoot && (
            <TerminalPanel
              cwd={info.data.worktreeRoot}
              repoId={repoId}
              visible={layout.terminalOpen}
              onClose={() => layout.patch({ terminalOpen: false })}
              height={layout.terminalHeight}
              onHeightChange={(h) => layout.patch({ terminalHeight: h })}
            />
          )}
        </div>
        {!fit.rightHidden && (
          <>
            <Splitter
              label="Resize commit detail panel"
              size={fit.right}
              min={RIGHT_MIN}
              max={fit.rightMax}
              direction={-1}
              onResize={(w) => layout.patch({ rightPanelWidth: w })}
            />
            <div className={styles.right} style={{ width: fit.right }} data-focus-zone="right">
              <RightPanel repoId={repoId} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
