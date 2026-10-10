import { KeyRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';

import type { EventContract } from '../../../shared/ipc/contract';
import { openIntegrationsPreferences } from '../integrations/api';
import { invoke, on } from '../lib/api';
import styles from './Dialogs.module.css';

type PromptReq = EventContract['git:prompt'];

const usePrompts = create<{ queue: PromptReq[] }>(() => ({ queue: [] }));
on('git:prompt', (p) => usePrompts.setState((s) => ({ queue: [...s.queue, p] })));

const TITLES: Record<PromptReq['kind'], string> = {
  username: 'Username required',
  password: 'Password required',
  passphrase: 'SSH key passphrase',
  hostkey: 'Unknown host',
  generic: 'Git needs input',
};

/** Answers git credential / passphrase / host-key prompts routed through askpass (spec 02 §6.3, spec 09). */
export function CredentialPromptHost() {
  const current = usePrompts((s) => s.queue[0]);
  if (!current) return null;
  return <CredentialPrompt key={current.promptId} req={current} />;
}

function CredentialPrompt({ req }: { req: PromptReq }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(req.kind !== 'hostkey');
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);

  const answer = (v: string | null): void => {
    void invoke('git:prompt:answer', { promptId: req.promptId, value: v, remember: v !== null && remember });
    usePrompts.setState((s) => ({ queue: s.queue.slice(1) }));
  };

  const secret = req.kind === 'password' || req.kind === 'passphrase';

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-label={TITLES[req.kind]}
      onCancel={(e) => {
        e.preventDefault();
        answer(null);
      }}
    >
      <h2 className={styles.title}>
        <KeyRound size={15} aria-hidden /> {TITLES[req.kind]}
      </h2>
      {req.kind === 'hostkey' ? (
        <div className={styles.body}>
          <pre className={styles.message} style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
            {req.text}
          </pre>
          <div className={styles.buttons}>
            <button type="button" onClick={() => answer('no')}>
              Reject
            </button>
            <button type="button" className="primary" autoFocus onClick={() => answer('yes')}>
              Trust host
            </button>
          </div>
        </div>
      ) : (
        <form
          className={styles.body}
          onSubmit={(e) => {
            e.preventDefault();
            answer(value);
          }}
        >
          <label className={styles.label}>{req.text.trim()}</label>
          <input
            className={styles.input}
            autoFocus
            type={secret ? 'password' : 'text'}
            aria-label={req.text.trim()}
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {req.kind !== 'generic' && (
            <label className={styles.check}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{' '}
              Remember
              {req.host ? ` for ${req.host}` : ''} (saved encrypted on this computer once the operation
              succeeds)
            </label>
          )}
          {(req.kind === 'password' || req.kind === 'username') && (
            <button
              type="button"
              style={{
                alignSelf: 'flex-start',
                background: 'none',
                border: 'none',
                padding: 0,
                color: 'var(--kl-blue)',
                cursor: 'pointer',
              }}
              onClick={() => {
                answer(null);
                openIntegrationsPreferences();
              }}
            >
              Connect a GitHub, GitLab, Bitbucket or Azure DevOps account instead
            </button>
          )}
          <div className={styles.buttons}>
            <button type="button" onClick={() => answer(null)}>
              Cancel
            </button>
            <button type="submit" className="primary">
              Continue
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
