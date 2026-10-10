import type { RefInfo, RepoId } from '@githappens/git/types';
import { useEffect, useRef, useState } from 'react';

import { invoke } from '../../lib/api';
import { normalizeRefInput, refNameProblem } from './ref-names';
import s from './Ops.module.css';

export { normalizeRefInput };

export interface InlineRefNameInputProps {
  repoId: RepoId;
  kind: 'branch' | 'tag';
  initial?: string;
  /** Current name when renaming (an unchanged name is not "already exists"). */
  current?: string;
  onSubmit(name: string): void;
  onCancel(): void;
  className?: string;
}

/**
 * Inline create/rename editor for a graph or left-panel row (spec 05 §4.3): validation on every keystroke
 * (debounced 100 ms) through `git check-ref-format` + an existence check, red border + tooltip when invalid,
 * Enter = submit, Esc / blur = cancel.
 */
export function InlineRefNameInput(p: InlineRefNameInputProps) {
  const [value, setValue] = useState(p.initial ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const refs = useRef<RefInfo[] | null>(null);
  const seq = useRef(0);
  const done = useRef(false);

  useEffect(() => {
    void invoke('git:refs', { repoId: p.repoId })
      .then((r) => (refs.current = r))
      .catch(() => undefined);
  }, [p.repoId]);

  const validate = async (name: string): Promise<string | null> => {
    const existing = (refs.current ?? [])
      .filter((r) => r.type === (p.kind === 'tag' ? 'tag' : 'local'))
      .map((r) => r.shortName)
      .filter((n) => n !== p.current);
    const local = refNameProblem(name, existing, {
      caseInsensitive: window.api?.platform === 'win32' || window.api?.platform === 'darwin',
      kind: p.kind,
    });
    if (local) return local;
    const v = await invoke('git:branch:validateName', { repoId: p.repoId, name }).catch(() => ({
      valid: true,
      reason: undefined,
    }));
    return v.valid ? null : (v.reason ?? 'That is not a valid name.');
  };

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  /** Every keystroke: normalize, then validate after 100 ms of quiet (latest input wins). */
  const change = (raw: string): void => {
    const next = normalizeRefInput(raw);
    setValue(next);
    const id = ++seq.current;
    if (timer.current) clearTimeout(timer.current);
    if (!next) {
      setProblem(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    timer.current = setTimeout(() => {
      void validate(next).then((r) => {
        if (id !== seq.current) return;
        setProblem(r);
        setChecking(false);
      });
    }, 100);
  };

  const finish = (fn: () => void): void => {
    if (done.current) return;
    done.current = true;
    fn();
  };

  const submit = async (): Promise<void> => {
    if (!value.trim()) return finish(p.onCancel);
    const err = await validate(value);
    if (err) {
      setProblem(err);
      return;
    }
    if (p.current !== undefined && value === p.current) return finish(p.onCancel);
    finish(() => p.onSubmit(value));
  };

  return (
    <span className={`${s.inline} ${p.className ?? ''}`}>
      <input
        autoFocus
        className={problem ? s.inlineInvalid : s.inlineInput}
        aria-label={p.kind === 'tag' ? 'Tag name' : 'Branch name'}
        aria-invalid={!!problem}
        aria-busy={checking}
        spellCheck={false}
        value={value}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(p.onCancel);
          }
        }}
        onBlur={() => finish(p.onCancel)}
        onMouseDown={(e) => e.stopPropagation()}
      />
      {problem && (
        <span className={s.inlineTip} role="alert">
          {problem}
        </span>
      )}
    </span>
  );
}
