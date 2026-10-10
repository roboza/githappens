import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';

import { formatDate } from '../../lib/format';
import { Markdown } from '../update/Markdown';
import { errorText, reposInvoke } from './api';
import { remoteLabel } from './repo-groups';
import styles from './Repos.module.css';

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Repository details side panel (spec 03 §4.1 `<RepoDetailsPane>`): branch, remotes, last commit, size, README. */
export function RepoDetailsPane({ path, onClose }: { path: string; onClose(): void }) {
  const q = useQuery({
    queryKey: ['repos:details', path],
    queryFn: () => reposInvoke('repos:details', { path }),
    staleTime: 30_000,
  });
  const d = q.data;
  return (
    <aside className={styles.details} aria-label="Repository details">
      <header className={styles.detailsHeader}>
        <h2 title={path}>{path.split(/[\\/]/).pop()}</h2>
        <button type="button" className={styles.iconBtn} aria-label="Close details" onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      {q.isLoading && <p className={styles.muted}>Loading…</p>}
      {q.error && <p className={styles.error}>{errorText(q.error)}</p>}
      {d && (
        <>
          <dl className={styles.facts}>
            <dt>Path</dt>
            <dd className={styles.mono}>{d.path}</dd>
            {d.isBare && (
              <>
                <dt>Type</dt>
                <dd>Bare repository</dd>
              </>
            )}
            {d.branch && (
              <>
                <dt>Branch</dt>
                <dd className={styles.mono}>{d.branch}</dd>
              </>
            )}
            <dt>Remotes</dt>
            <dd>
              {d.remotes.length === 0
                ? 'None'
                : d.remotes.map((r) => (
                    <div key={r.name} title={r.url}>
                      <span className={styles.mono}>{r.name}</span> {remoteLabel(r.url)}
                    </div>
                  ))}
            </dd>
            {d.lastCommit && (
              <>
                <dt>Last commit</dt>
                <dd>
                  <div>{d.lastCommit.subject}</div>
                  <div className={styles.muted}>
                    {d.lastCommit.author} · {formatDate(d.lastCommit.date)} ·{' '}
                    <span className={styles.mono}>{d.lastCommit.sha.slice(0, 7)}</span>
                  </div>
                </dd>
              </>
            )}
            {d.sizeBytes !== undefined && (
              <>
                <dt>Size</dt>
                <dd>{formatSize(d.sizeBytes)}</dd>
              </>
            )}
          </dl>
          {d.readme ? (
            <section className={styles.readme} aria-label={d.readme.name}>
              <h3>{d.readme.name}</h3>
              <Markdown source={d.readme.markdown} />
              {d.readme.truncated && <p className={styles.muted}>README truncated.</p>}
            </section>
          ) : (
            <p className={styles.muted}>No README.</p>
          )}
        </>
      )}
    </aside>
  );
}
