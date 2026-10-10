import { FolderOpen, RotateCcw } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';

import type { SettingDescriptor, SettingKey } from '../../../../shared/settings/registry';
import { IpcError } from '../../lib/api';
import { prefsInvoke, useSettingsStore } from '../../stores/settings';
import s from './PreferencesView.module.css';
import { scopeBadge } from './scope-badge';

const errorText = (e: unknown): string =>
  e instanceof IpcError ? e.error.message : e instanceof Error ? e.message : String(e);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Scope badge shown on every setting row (spec 13 §4.1 `SettingRow` scope badge). */
export function ScopeBadge({ scope }: { scope: string }) {
  const b = scopeBadge(scope);
  return (
    <span className={b.accent ? s.badgeAccent : s.badge} title={b.title} data-scope={scope}>
      {b.label}
    </span>
  );
}

/** Generic row for one registry setting (spec 13 §4.1 `SettingRow`). Changes apply immediately. */
export function SettingRow({ d }: { d: SettingDescriptor }) {
  const value = useSettingsStore((st) => st.values?.[d.key as SettingKey]);
  const setSetting = useSettingsStore((st) => st.set);
  const resetSetting = useSettingsStore((st) => st.reset);
  const [error, setError] = useState<string | null>(null);

  const commit = async (v: unknown): Promise<void> => {
    if (same(v, value)) return;
    try {
      setError(null);
      await setSetting(d.key as SettingKey, v as never);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const onReset = async (): Promise<void> => {
    try {
      setError(null);
      await resetSetting(d.key as SettingKey);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const id = `setting-${d.key}`;
  const isDefault = same(value, d.default);

  return (
    <div className={s.row} data-setting={d.key}>
      <div className={s.rowText}>
        <label htmlFor={id} className={s.rowTitle}>
          {d.title}
          <ScopeBadge scope={d.scope} />
          {d.gitConfigKey && <span className={s.badgeAccent}>git config: {d.gitConfigKey}</span>}
          {d.planned && (
            <span className={s.badgeWarn} title="Saved, but no feature uses it yet">
              Not applied yet
            </span>
          )}
          {d.requiresRestart && <span className={s.badgeWarn}>Restart required</span>}
        </label>
        <p className={s.rowDesc}>{d.description}</p>
        <span className={s.rowKey}>{d.key}</span>
      </div>
      <div className={s.control}>
        {/* Keyed by value so drafts reset when the setting changes elsewhere. */}
        <Control key={JSON.stringify(value)} id={id} d={d} value={value} onCommit={commit} />
      </div>
      {!isDefault ? (
        <button
          type="button"
          className={s.reset}
          title={`Reset to default (${JSON.stringify(d.default)})`}
          aria-label={`Reset ${d.title} to default`}
          onClick={() => void onReset()}
        >
          <RotateCcw size={14} />
        </button>
      ) : (
        <span />
      )}
      {error && (
        <p className={s.rowError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface ControlProps {
  id: string;
  d: SettingDescriptor;
  value: unknown;
  onCommit(v: unknown): Promise<void>;
}

function Control({ id, d, value, onCommit }: ControlProps) {
  switch (d.type) {
    case 'boolean':
      return (
        <input
          id={id}
          type="checkbox"
          role="switch"
          className={s.toggle}
          checked={value === true}
          onChange={(e) => void onCommit(e.target.checked)}
        />
      );
    case 'enum':
      return (
        <select id={id} value={String(value ?? '')} onChange={(e) => void onCommit(e.target.value)}>
          {(d.enum ?? []).map((o) => (
            <option key={String(o)} value={String(o)}>
              {d.enumLabels?.[String(o)] ?? String(o)}
            </option>
          ))}
        </select>
      );
    case 'number':
      return (
        <NumberControl id={id} d={d} value={typeof value === 'number' ? value : 0} onCommit={onCommit} />
      );
    case 'list':
      return (
        <ListControl id={id} value={Array.isArray(value) ? (value as string[]) : []} onCommit={onCommit} />
      );
    case 'path':
      return <PathControl id={id} d={d} value={String(value ?? '')} onCommit={onCommit} />;
    default:
      return <TextControl id={id} d={d} value={String(value ?? '')} onCommit={onCommit} />;
  }
}

const commitOnEnter = (e: KeyboardEvent<HTMLInputElement>): void => {
  if (e.key === 'Enter') e.currentTarget.blur();
};

function NumberControl({ id, d, value, onCommit }: Omit<ControlProps, 'value'> & { value: number }) {
  const [draft, setDraft] = useState(String(value));
  const commit = (): void => {
    const n = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    void onCommit(n);
  };
  return (
    <>
      <input
        id={id}
        type="number"
        min={d.min}
        max={d.max}
        step={d.step ?? 1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={commitOnEnter}
      />
      {d.unit && <span className={s.unit}>{d.unit}</span>}
    </>
  );
}

function TextControl({ id, d, value, onCommit }: Omit<ControlProps, 'value'> & { value: string }) {
  const [draft, setDraft] = useState(value);
  return (
    <>
      {d.type === 'color' && (
        <input
          type="color"
          aria-label={`${d.title} color`}
          value={/^#[0-9a-f]{6}$/i.test(draft) ? draft : '#000000'}
          onChange={(e) => {
            setDraft(e.target.value);
            void onCommit(e.target.value);
          }}
        />
      )}
      <input
        id={id}
        type="text"
        spellCheck={false}
        placeholder={d.placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void onCommit(draft)}
        onKeyDown={commitOnEnter}
        style={d.type === 'font' ? { fontFamily: draft } : undefined}
      />
    </>
  );
}

function PathControl({ id, d, value, onCommit }: Omit<ControlProps, 'value'> & { value: string }) {
  const [draft, setDraft] = useState(value);
  const browse = async (): Promise<void> => {
    try {
      const p = await prefsInvoke('prefs:pickPath', {
        kind: d.pathKind ?? 'file',
        title: d.title,
        defaultPath: draft || undefined,
      });
      if (p) {
        setDraft(p);
        await onCommit(p);
      }
    } catch (e) {
      console.warn('[prefs] path picker unavailable', e);
    }
  };
  return (
    <>
      <input
        id={id}
        type="text"
        spellCheck={false}
        placeholder={d.placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void onCommit(draft.trim())}
        onKeyDown={commitOnEnter}
      />
      <button
        type="button"
        title="Browse…"
        aria-label={`Browse for ${d.title}`}
        onClick={() => void browse()}
      >
        <FolderOpen size={14} />
      </button>
    </>
  );
}

function ListControl({
  id,
  value,
  onCommit,
}: {
  id: string;
  value: string[];
  onCommit(v: unknown): Promise<void>;
}) {
  const [draft, setDraft] = useState(value.join('\n'));
  return (
    <textarea
      id={id}
      rows={Math.min(6, Math.max(2, value.length + 1))}
      spellCheck={false}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() =>
        void onCommit(
          draft
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean),
        )
      }
    />
  );
}
