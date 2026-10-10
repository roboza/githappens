import type { CommandLogEntry } from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';

import { Modal } from '../components/Modal';
import { formatCommandLine } from '../views/activity/format';
import { invoke } from '../lib/api';
import { useToastStore } from '../stores/toasts';
import { behaviourInvoke } from './api';
import styles from './Notifications.module.css';

/** "Details" of a failed op (spec 01 §4.10): the git command and its full output from the output log. */
export function DetailsModal() {
  const item = useToastStore((s) => s.detailsFor);
  const close = useToastStore((s) => s.showDetails);
  const d = item?.details;
  const entries = useQuery({
    queryKey: ['git:output:op', d?.repoId, d?.opId],
    enabled: !!d?.repoId && !!d?.opId,
    queryFn: async (): Promise<CommandLogEntry[]> => {
      const all = await behaviourInvoke('git:output:list', { repoId: d!.repoId!, limit: 500 });
      return all.filter((e) => e.opId === d!.opId);
    },
  });
  const copy = (text: string): void => void invoke('shell:copyText', { text }).catch(() => undefined);

  return (
    <Modal title={item?.title ?? 'Details'} open={!!item} onClose={() => close(null)}>
      <div className={styles.details}>
        {item?.body && !d?.command && <p className={styles.detailsBody}>{item.body}</p>}
        {d?.command && (
          <section>
            <h3>Command</h3>
            <div className={styles.cmdRow}>
              <code className={styles.cmd}>{d.command}</code>
              <button type="button" onClick={() => copy(d.command!)}>
                Copy
              </button>
            </div>
          </section>
        )}
        {entries.data && entries.data.length > 0 ? (
          <section>
            <h3>
              Git output ({entries.data.length} command{entries.data.length === 1 ? '' : 's'})
            </h3>
            {entries.data.map((e) => (
              <div key={e.id} className={styles.entry}>
                <div className={styles.entryHead}>
                  <code>{formatCommandLine(e.argv)}</code>
                  <span className={e.exitCode === 0 ? styles.ok : styles.bad}>
                    {e.exitCode === null ? 'killed' : `exit ${e.exitCode}`} · {e.durationMs} ms
                  </span>
                </div>
                {(e.stderr || e.stdoutPreview) && (
                  <pre className={styles.output}>
                    {[e.stdoutPreview, e.stderr].filter(Boolean).join('\n')}
                  </pre>
                )}
              </div>
            ))}
          </section>
        ) : (
          d?.output && (
            <section>
              <h3>Output</h3>
              <pre className={styles.output}>{d.output}</pre>
            </section>
          )
        )}
        {d?.output && (
          <div className={styles.actionsRow}>
            <button type="button" onClick={() => copy([d.command, d.output].filter(Boolean).join('\n'))}>
              Copy all
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
