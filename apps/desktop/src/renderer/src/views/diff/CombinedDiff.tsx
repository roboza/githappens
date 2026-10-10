import type { RepoId } from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';

import { filesInvoke } from '../file/files-api';
import { codeStyle, type EditorPrefs } from './editor-prefs';
import { Code } from './HunkView';
import styles from './DiffView.module.css';

/** Merge commit combined view (`git show --cc`, spec 07 §4.2): one prefix column per parent. */
export function CombinedDiff(props: {
  repoId: RepoId;
  sha: string;
  path: string;
  prefs: EditorPrefs;
  wordWrap: boolean;
}) {
  const q = useQuery({
    queryKey: ['diff', props.repoId, 'combined', props.sha, props.path],
    queryFn: () =>
      filesInvoke('diff:combined', { repoId: props.repoId, sha: props.sha, paths: [props.path] }),
  });
  if (q.isLoading) return <p className={styles.message}>Loading combined diff…</p>;
  if (q.error)
    return <p className={styles.message}>Could not load the combined diff: {(q.error as Error).message}</p>;
  const file = q.data?.[0];
  if (!file) {
    return (
      <p className={styles.message}>
        This file has no combined changes: it matches one of the parents (no conflicts were resolved in it).
      </p>
    );
  }
  if (file.binary) return <p className={styles.message}>Binary file changed in the merge.</p>;
  return (
    <div
      className={styles.hunks}
      style={codeStyle(props.prefs, props.wordWrap)}
      role="table"
      aria-label="Combined diff"
    >
      {file.hunks.map((h, i) => (
        <section key={i} className={styles.hunk}>
          <div className={styles.hunkHeader} role="row">
            <span className={styles.hunkTitle}>{h.header}</span>
          </div>
          {h.lines.map((l, j) => {
            const added = l.prefix.includes('+');
            const removed = l.prefix.includes('-');
            return (
              <div
                key={j}
                role="row"
                className={`${styles.combinedLine} ${added ? styles.add : removed ? styles.del : ''}`}
              >
                <span className={styles.sign}>{l.prefix.replace(/ /g, ' ')}</span>
                <span className={styles.code}>
                  <Code text={l.content} prefs={props.prefs} />
                </span>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
