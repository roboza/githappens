import type { RepoId } from '@githappens/git/types';
import type { Issue, IssueRef } from '@githappens/providers/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';

import type { MenuEntry } from '../../components/ContextMenu';
import { errorLine, intInvoke } from '../../integrations/api';
import { ik } from '../../integrations/queries';
import { useToastStore } from '../../stores/toasts';
import { CreateBranchFromIssueDialog } from './CreateBranchFromIssueDialog';
import { CreateIssueDialog } from './CreateIssueDialog';
import { IssueDetailPanel } from './IssueDetailPanel';
import {
  onQueryClient,
  rememberedQueryClient,
  useIssueUi,
  type BranchRequest,
  type CreateIssueRequest,
} from './issue-store';

/**
 * Own React root for the issue panel + dialogs (like ai/mount.tsx), wrapped in the app's QueryClient
 * (remembered by the issue components of the main tree) so invalidations reach the rest of the UI.
 */

let root: Root | null = null;
let hostClient: QueryClient | null = null;
let fallbackClient: QueryClient | null = null;

function renderHost(qc: QueryClient): void {
  hostClient = qc;
  root!.render(
    <QueryClientProvider client={qc}>
      <IssueHost />
    </QueryClientProvider>,
  );
}

function ensureHost(): QueryClient {
  const qc =
    rememberedQueryClient() ??
    (fallbackClient ??= new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } }));
  if (!root) {
    const el = document.createElement('div');
    el.dataset.issueHost = '';
    document.body.appendChild(el);
    root = createRoot(el);
    onQueryClient((next) => {
      if (root && next !== hostClient) renderHost(next);
    });
  }
  if (qc !== hostClient) renderHost(qc);
  return qc;
}

function IssueHost() {
  const detail = useIssueUi((s) => s.detail);
  const branch = useIssueUi((s) => s.branch);
  const create = useIssueUi((s) => s.create);
  return (
    <>
      {detail && (
        <IssueDetailPanel
          key={`${detail.ref.integrationKey}|${detail.ref.scope}|${detail.ref.key}`}
          target={detail}
          onClose={() => useIssueUi.setState({ detail: null })}
        />
      )}
      {create && <CreateIssueDialog req={create} onClose={() => useIssueUi.setState({ create: null })} />}
      {branch && (
        <CreateBranchFromIssueDialog
          key={`${branch.repoId}|${branch.issue.key}`}
          req={branch}
          onClose={() => {
            useIssueUi.setState({ branch: null });
            branch.resolve();
          }}
        />
      )}
    </>
  );
}

/** Open the Issue panel (spec 10 §4.9). `issue` seeds the cache so the panel renders immediately. */
export function openIssueDetail(ref: IssueRef, opts: { repoId?: RepoId; issue?: Issue } = {}): void {
  const qc = ensureHost();
  const key = ik.issue(ref.integrationKey, ref.scope, ref.key);
  if (opts.issue && qc.getQueryData(key) === undefined) qc.setQueryData(key, opts.issue);
  useIssueUi.setState({ detail: { ref, repoId: opts.repoId } });
}

export function openCreateIssue(req: CreateIssueRequest): void {
  ensureHost();
  useIssueUi.setState({ create: req });
}

/** Open CreateBranchFromIssueDialog; resolves when the branch was created or the dialog cancelled. */
export function openCreateBranchFromIssue(req: Omit<BranchRequest, 'resolve'>): Promise<void> {
  ensureHost();
  return new Promise<void>((resolve) => {
    useIssueUi.getState().branch?.resolve(); // a replaced request counts as cancelled
    useIssueUi.setState({ branch: { ...req, resolve } });
  });
}

/**
 * Branch context-menu items "View issue ABC-12" / "Unlink issue" (spec 10 §4.9). Menus are built
 * synchronously, so this reads the links already cached by the graph badges / left panel.
 */
export function issueMenuItems(repoId: RepoId, branch: string): MenuEntry[] {
  const qc = rememberedQueryClient();
  const ref = qc?.getQueryData<Record<string, IssueRef>>(ik.issueLinks(repoId))?.[branch];
  if (!qc || !ref) return [];
  return [
    { label: `View issue ${ref.key}`, onSelect: () => openIssueDetail(ref, { repoId }) },
    {
      label: `Unlink issue ${ref.key}`,
      title: 'Remove the link between this branch and the issue',
      onSelect: () =>
        void intInvoke('issues:setLink', { repoId, branch, issue: null })
          .then(() => qc.invalidateQueries({ queryKey: ik.issueLinks(repoId) }))
          .catch((e: unknown) =>
            useToastStore
              .getState()
              .push({ kind: 'error', title: `Could not unlink ${ref.key}`, body: errorLine(e) }),
          ),
    },
  ];
}
