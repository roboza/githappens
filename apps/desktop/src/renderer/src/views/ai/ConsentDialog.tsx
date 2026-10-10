import { Sparkles } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { AI_PROVIDER_LABELS, type AiStatus } from '../../../../shared/ipc/ai-contract';
import s from './Ai.module.css';

/**
 * One-time consent (spec 12 §4.4): what is sent and where. Shown on first use and again whenever the
 * provider or endpoint changes (the stored consent key no longer matches).
 */
export function ConsentDialog({ status, onDone }: { status: AiStatus; onDone(ok: boolean): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(status.endpoint);
  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-label="Allow AI features"
      onCancel={(e) => {
        e.preventDefault();
        onDone(false);
      }}
    >
      <h2 className={s.dialogTitle}>
        <Sparkles size={16} /> Send code to {AI_PROVIDER_LABELS[status.provider]}?
      </h2>
      <div className={s.dialogBody}>
        <p>
          AI features send parts of this repository directly from this computer to{' '}
          {local ? 'a server on this computer' : AI_PROVIDER_LABELS[status.provider]}:
        </p>
        <div className={s.endpoint}>
          {status.endpoint || '(default endpoint)'} · model {status.model || '(not set)'}
        </div>
        <ul>
          <li>diffs of the changes you ask about (staged changes, commits, branches, conflicts)</li>
          <li>file paths, commit messages, branch and author names</li>
          <li>your custom instructions and the repository&apos;s .githappens/ai-instructions.md</li>
        </ul>
        <p className={s.note}>
          Files matching your excluded patterns (lockfiles, .env files, keys…) are sent by name only, and
          likely secrets are replaced with [REDACTED]. Nothing is sent until you use an AI feature. You can
          disable AI for a repository with <code>git config githappens.ai false</code>.
        </p>
        <div className={s.buttons}>
          <button type="button" onClick={() => onDone(false)}>
            Cancel
          </button>
          <button type="button" className="primary" autoFocus onClick={() => onDone(true)}>
            Allow
          </button>
        </div>
      </div>
    </dialog>
  );
}
