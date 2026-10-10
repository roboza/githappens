import type { RepoId } from '@githappens/git/types';
import type { PullRequest } from '@githappens/providers/types';
import { RefreshCw } from 'lucide-react';

import { uiStyles } from '../../integrations/ui';
import { CompareView } from '../diff/CompareView';
import { PrFetchGate, type PrFetch } from './PrCommitsTab';
import s from './PullRequestView.module.css';

/**
 * Files changed tab (spec 10 §4.7): the embedded comparison `base...head` (three-dot) of the fetched PR refs.
 * Note: CompareView's own close button returns to the graph (it is shared with the compare center view).
 */
export function PrFilesTab({ repoId, pr, fetch }: { repoId: RepoId; pr: PullRequest; fetch: PrFetch }) {
  return (
    <PrFetchGate pr={pr} fetch={fetch}>
      {({ baseRef, headRef }) => (
        <div className={s.filesPane}>
          <div className={s.tabToolbar}>
            <span className={s.grow}>
              Changes in <code>{pr.head.branch}</code> since it diverged from <code>{pr.base.branch}</code>
            </span>
            <button
              type="button"
              className={s.iconBtn}
              title="Fetch the pull request again"
              disabled={fetch.isFetching}
              onClick={() => void fetch.refetch()}
            >
              <RefreshCw size={12} className={fetch.isFetching ? uiStyles.spin : undefined} /> Fetch again
            </button>
          </div>
          <div className={s.filesBody}>
            <CompareView
              key={`${baseRef}...${headRef}`}
              repoId={repoId}
              view={{
                kind: 'diff',
                spec: { kind: 'range', from: baseRef, to: headRef, threeDot: true },
                path: '',
                title: `${pr.base.branch} ↔ ${pr.head.branch}`,
                oldRev: baseRef,
                newRev: headRef,
              }}
            />
          </div>
        </div>
      )}
    </PrFetchGate>
  );
}
