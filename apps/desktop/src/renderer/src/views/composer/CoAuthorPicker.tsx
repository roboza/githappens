import type { CoAuthor } from '@githappens/git/ops';
import type { RepoId } from '@githappens/git/types';
import { UserPlus, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { commitInvokeOr } from './api';
import { addCoAuthor, formatCoAuthor, parseCoAuthor } from './helpers';
import s from './Composer.module.css';

const DEBOUNCE_MS = 150;

/**
 * Co-author chips with autocomplete (spec 06 §4.5): suggestions come from `git shortlog -sne --all`
 * and provider collaborators (`commit:coAuthorSuggestions`); "Name <email>" can always be typed.
 * The chips become `Co-authored-by:` trailers on commit.
 */
export function CoAuthorPicker(props: { repoId: RepoId; value: CoAuthor[]; onChange(v: CoAuthor[]): void }) {
  const { repoId, value, onChange } = props;
  const [open, setOpen] = useState(value.length > 0);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<CoAuthor[]>([]);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focused) return;
    let cancelled = false;
    const t = setTimeout(() => {
      void commitInvokeOr('commit:coAuthorSuggestions', { repoId, q, limit: 8 }, []).then((r) => {
        if (cancelled) return;
        const taken = new Set(value.map((c) => c.email.toLowerCase()));
        setItems(r.filter((c) => !taken.has(c.email.toLowerCase())));
        setActive(0);
      });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [repoId, q, focused, value]);

  const add = (c: CoAuthor): void => {
    onChange(addCoAuthor(value, c));
    setQ('');
  };

  if (!open && value.length === 0) {
    return (
      <button
        type="button"
        className={s.addCoAuthor}
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
      >
        <UserPlus size={13} /> Add co-author
      </button>
    );
  }

  const typed = parseCoAuthor(q);
  const showList = focused && (items.length > 0 || !!typed);

  return (
    <div className={s.coAuthors}>
      {value.map((c) => (
        <span key={c.email} className={s.chip} title={formatCoAuthor(c)}>
          {c.name}
          <button
            type="button"
            aria-label={`Remove co-author ${c.name}`}
            onClick={() => onChange(value.filter((x) => x !== c))}
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <div className={s.coAuthorInput}>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Add co-author"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          placeholder={value.length ? 'Add another…' : 'Co-author name or email'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const n = items.length;
              if (n) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
            } else if (e.key === 'Enter' && !(e.ctrlKey || e.metaKey)) {
              const pick = items[active] ?? typed;
              if (!pick) return;
              e.preventDefault();
              e.stopPropagation();
              add(pick);
            } else if (e.key === 'Backspace' && !q && value.length) {
              onChange(value.slice(0, -1));
            } else if (e.key === 'Escape' && q) {
              e.stopPropagation();
              setQ('');
            }
          }}
        />
        {showList && (
          <ul id={listId} role="listbox" className={s.suggestions}>
            {items.map((c, i) => (
              <li
                key={c.email}
                role="option"
                aria-selected={i === active}
                className={i === active ? s.activeSuggestion : undefined}
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(c);
                }}
              >
                <span>{c.name}</span> <span className={s.muted}>{c.email}</span>
              </li>
            ))}
            {typed && !items.some((c) => c.email.toLowerCase() === typed.email.toLowerCase()) && (
              <li
                role="option"
                aria-selected={items.length === 0}
                className={items.length === 0 ? s.activeSuggestion : undefined}
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(typed);
                }}
              >
                Add {formatCoAuthor(typed)}
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
