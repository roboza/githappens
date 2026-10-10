import { BarChart3, RefreshCw } from 'lucide-react';
import { createElement, useCallback, useEffect, useRef, useState } from 'react';

import type { InsightsRange, InsightsResult } from '../../../../shared/ipc/insights-contract';
import type { Workspace } from '../../../../shared/ipc/workspaces-contract';
import { mountDialog } from '../../ai/mount';
import { errorText, extrasInvoke, extrasOn } from '../../cloud/extras-api';
import { invoke } from '../../lib/api';
import { BarChart, HBarChart, LineChart } from './charts';
import s from './Insights.module.css';

/** Open Insights for a workspace (spec 14 §4.5). */
export function openInsights(workspaceId: string): Promise<void> {
  return mountDialog<void>((done) => createElement(InsightsView, { workspaceId, onClose: () => done() }));
}

/** "Insights" button for the WorkspaceView header. Mount: `<InsightsButton workspaceId={ws.id} />`. */
export function InsightsButton({ workspaceId, className }: { workspaceId: string; className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => void openInsights(workspaceId)}
      title="PR cycle time, reviews, throughput and DORA metrics (computed locally)"
    >
      <BarChart3 size={14} /> Insights
    </button>
  );
}

const hrs = (h: number): string =>
  h >= 48 ? `${(h / 24).toFixed(1)} d` : h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(h * 60)} min`;

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={s.tile}>
      <span className={s.tileLabel}>{label}</span>
      <span className={s.tileValue}>{value}</span>
      {sub && <span className={s.tileSub}>{sub}</span>}
    </div>
  );
}

export function InsightsView({ workspaceId, onClose }: { workspaceId: string; onClose?(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [range, setRange] = useState<InsightsRange>('30d');
  const [repos, setRepos] = useState<Set<string> | null>(null);
  const [author, setAuthor] = useState('');
  const [result, setResult] = useState<InsightsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    void invoke('workspace:list', {}).then((list) => setWs(list.find((w) => w.id === workspaceId) ?? null));
    return extrasOn('insights:progress', (p) => {
      if (p.workspaceId === workspaceId) setProgress({ done: p.done, total: p.total });
    });
  }, [workspaceId]);

  const load = useCallback(
    async (force = false) => {
      setBusy(true);
      setError(null);
      try {
        setResult(
          await extrasInvoke('insights:compute', {
            workspaceId,
            range,
            ...(repos ? { repos: [...repos] } : {}),
            ...(author ? { authors: [author] } : {}),
            ...(force ? { force: true } : {}),
          }),
        );
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [workspaceId, range, repos, author],
  );
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const r = result;
  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-label="Insights"
      onCancel={(e) => {
        e.preventDefault();
        onClose?.();
      }}
    >
      <div className={s.header}>
        <h2>Insights · {ws?.name ?? 'Workspace'}</h2>
        <label className={s.muted}>
          Range{' '}
          <select value={range} onChange={(e) => setRange(e.target.value as InsightsRange)}>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
          </select>
        </label>
        <label className={s.muted}>
          Author{' '}
          <select value={author} onChange={(e) => setAuthor(e.target.value)}>
            <option value="">Everyone</option>
            {(r?.authors ?? []).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => void load(true)} disabled={busy} title="Ignore the 6-hour cache">
          <RefreshCw size={14} /> Refresh
        </button>
        {onClose && (
          <button type="button" onClick={onClose}>
            Close
          </button>
        )}
      </div>
      {progress && progress.total > 0 && (
        <div className={s.progress} style={{ width: `${(100 * progress.done) / progress.total}%` }} />
      )}
      <div className={s.body}>
        {ws && ws.repos.length > 1 && (
          <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className={s.muted}>Repositories</legend>
            <ul className={s.repos}>
              {ws.repos.map((repo) => (
                <li key={repo.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!repos || repos.has(repo.id)}
                      onChange={(e) => {
                        const next = new Set(repos ?? ws.repos.map((x) => x.id));
                        if (e.target.checked) next.add(repo.id);
                        else next.delete(repo.id);
                        setRepos(next.size === ws.repos.length ? null : next);
                      }}
                    />
                    {repo.name}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        {!r && busy && <p className={s.muted}>Computing from your providers’ APIs…</p>}
        {r && (
          <>
            <div className={s.tiles}>
              <Tile
                label="PR cycle time"
                value={r.sampleSize ? hrs(r.prCycleTimeHrs.median) : '—'}
                sub={r.sampleSize ? `median · p75 ${hrs(r.prCycleTimeHrs.p75)}` : 'no merged PRs'}
              />
              <Tile
                label="Time to first review"
                value={r.timeToFirstReviewHrs.median ? hrs(r.timeToFirstReviewHrs.median) : '—'}
                sub={`median · p75 ${hrs(r.timeToFirstReviewHrs.p75)}`}
              />
              <Tile
                label="PRs merged / week"
                value={(r.sampleSize / Math.max(1, r.mergedPerWeek.length)).toFixed(1)}
                sub={`${r.sampleSize} merged`}
              />
              <Tile label="PR size" value={`${r.prSize.p50}`} sub={`lines changed · p90 ${r.prSize.p90}`} />
              {r.dora && (
                <>
                  <Tile
                    label="Deployment frequency"
                    value={`${r.dora.deploymentsPerWeek}/wk`}
                    sub={`${r.dora.deployments} deployments (${r.dora.signal === 'tags' ? 'tags' : 'GitHub'})`}
                  />
                  <Tile label="Lead time" value={hrs(r.dora.leadTimeHrs)} sub="median, change → deploy" />
                  <Tile
                    label="Change failure rate"
                    value={`${Math.round(r.dora.changeFailureRate * 100)}%`}
                    sub="failed or followed by revert/hotfix"
                  />
                  <Tile
                    label="MTTR"
                    value={r.dora.mttrHrs ? hrs(r.dora.mttrHrs) : '—'}
                    sub="failure → next good deploy"
                  />
                </>
              )}
            </div>
            <div className={s.charts}>
              <section className={s.card}>
                <h3>Cycle time trend (median per week)</h3>
                <LineChart
                  label="Median PR cycle time per week in hours"
                  unit=" h"
                  data={r.cycleTimeTrend.map((x) => ({ label: x.week, value: x.medianHrs }))}
                />
              </section>
              <section className={s.card}>
                <h3>Throughput (PRs merged per week)</h3>
                <BarChart
                  label="Pull requests merged per week"
                  shortLabels
                  data={r.mergedPerWeek.map((x) => ({ label: x.week, value: x.count }))}
                />
              </section>
              <section className={s.card}>
                <h3>Review load (PRs reviewed per reviewer)</h3>
                {r.reviewLoad.length ? (
                  <HBarChart
                    label="Pull requests reviewed per reviewer"
                    data={r.reviewLoad.map((x) => ({ label: x.reviewer, value: x.count }))}
                  />
                ) : (
                  <p className={s.muted}>No reviews in this range.</p>
                )}
              </section>
              <section className={s.card}>
                <h3>PR size distribution (lines changed)</h3>
                <BarChart
                  label="Pull request size distribution"
                  data={r.prSize.buckets.map((b) => ({ label: b.label, value: b.count }))}
                />
              </section>
            </div>
            <p className={s.footnote}>
              {r.source}.{' '}
              {r.dora
                ? ''
                : 'Configure a deployment signal (Preferences → Workspaces → Insights) for DORA metrics. '}
              Cached for 6 hours · computed {new Date(r.computedAt).toLocaleString()}.
            </p>
            {r.repos.some((x) => x.state !== 'ok') && (
              <ul className={s.footnote}>
                {r.repos
                  .filter((x) => x.state !== 'ok')
                  .map((x) => (
                    <li key={x.repoId} className={x.state === 'error' ? s.warn : ''}>
                      {x.name}: {x.message}
                    </li>
                  ))}
              </ul>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}
