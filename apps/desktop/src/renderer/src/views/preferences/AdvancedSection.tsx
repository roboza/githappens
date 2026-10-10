import { Editor } from '@monaco-editor/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { SettingsJsonDocument, SettingsJsonProblem } from '../../../../shared/ipc/prefs-contract';
import { EXPERIMENTS, hasExperiment, type ExperimentId } from '../../../../shared/settings/registry';
import { confirm } from '../../components/Dialogs';
import { IpcError } from '../../lib/api';
import { applyMonacoTheme, registerSettingsSchema, SETTINGS_MODEL_URI } from '../../lib/monaco';
import { prefsInvoke, useSetting, useSettingsStore } from '../../stores/settings';
import { useToastStore } from '../../stores/toasts';
import s from './PreferencesView.module.css';
import { ScopeBadge } from './SettingRow';

const errorText = (e: unknown): string =>
  e instanceof IpcError ? e.error.message : e instanceof Error ? e.message : String(e);

/**
 * Preferences › Advanced (spec 13 §4.2 "Advanced / Settings JSON"): settings.json in Monaco with
 * schema validation, save with main-side validation, reload on external edits, export / import of
 * a settings bundle and Reset all.
 */
export function AdvancedSection() {
  return (
    <>
      <SettingsJsonEditor />
      <ExportImport />
    </>
  );
}

function SettingsJsonEditor() {
  const [doc, setDoc] = useState<SettingsJsonDocument | null>(null);
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<SettingsJsonProblem[]>([]);
  const [markers, setMarkers] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = doc !== null && text !== doc.text;
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  });

  const load = useCallback(
    (): Promise<void> =>
      prefsInvoke('settings:readJson', {}).then(
        (d) => {
          registerSettingsSchema(d.schema);
          setDoc(d);
          setText(d.text);
          setProblems([]);
          setError(null);
        },
        (e: unknown) => setError(errorText(e)),
      ),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  // External edits (file watcher in main) and in-app changes reach us as settings:changed; reload
  // the document when the editor has no unsaved edits.
  const values = useSettingsStore((st) => st.values);
  useEffect(() => {
    if (!dirtyRef.current && doc) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

  const save = async (): Promise<void> => {
    setStatus(null);
    try {
      const r = await prefsInvoke('settings:writeJson', { text });
      setProblems(r.problems);
      if (r.ok) {
        setStatus('Saved.');
        await load();
      }
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className={s.group} role="region" aria-label="settings.json">
      <h3 className={s.groupTitle}>
        settings.json <ScopeBadge scope="profile" />
      </h3>
      {doc && <p className={s.rowDesc}>{doc.path}</p>}
      {doc?.readOnly && (
        <p className={s.error} role="alert">
          {doc.readOnlyReason}
        </p>
      )}
      <div style={{ height: 320, border: '1px solid var(--kl-panel-border)' }}>
        {doc && (
          <Editor
            path={SETTINGS_MODEL_URI}
            defaultLanguage="json"
            value={text}
            theme={applyMonacoTheme()}
            onChange={(v) => setText(v ?? '')}
            onValidate={(m) => setMarkers(m.length)}
            options={{ minimap: { enabled: false }, readOnly: doc.readOnly, tabSize: 2, fontSize: 12 }}
          />
        )}
      </div>
      <div className={s.toolbar}>
        <button
          type="button"
          className="primary"
          disabled={!dirty || doc?.readOnly}
          onClick={() => void save()}
        >
          Save
        </button>
        <button type="button" disabled={!dirty} onClick={() => doc && setText(doc.text)}>
          Revert
        </button>
        <button type="button" onClick={() => void load()}>
          Reload from disk
        </button>
        <button
          type="button"
          onClick={() =>
            void prefsInvoke('settings:openJson', {}).catch((e: unknown) => setError(errorText(e)))
          }
        >
          Open in external editor
        </button>
        <span className={s.spacer} />
        {markers > 0 && <span className={s.muted}>{markers} schema warning(s)</span>}
        {dirty && <span className={s.muted}>Unsaved changes</span>}
      </div>
      {problems.length > 0 && (
        <ul className={s.error} role="alert" aria-label="settings.json problems">
          {problems.map((p, i) => (
            <li key={i}>{p.message}</li>
          ))}
        </ul>
      )}
      {status && (
        <p className={s.ok} role="status">
          {status}
        </p>
      )}
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ExportImport() {
  const reset = useSettingsStore((st) => st.reset);
  const push = useToastStore((st) => st.push);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<string | null>): Promise<void> => {
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ ok: true, text });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  };
  return (
    <div className={s.group}>
      <h3 className={s.groupTitle}>Export, import and reset</h3>
      <p className={s.rowDesc}>
        Exports this profile&apos;s changed settings, keybindings and custom themes as one JSON file. Tokens,
        passwords and API keys are never included.
      </p>
      <div className={s.toolbar}>
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              const r = await prefsInvoke('prefs:export', {});
              if (!r) return null;
              return `Exported ${r.settings} settings, ${r.keybindings} keybindings and ${r.themes} themes to ${r.file}${
                r.omitted.length ? ` (left out: ${r.omitted.join(', ')})` : ''
              }.`;
            })
          }
        >
          Export settings…
        </button>
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              const r = await prefsInvoke('prefs:import', {});
              if (!r) return null;
              return `Imported ${r.applied} settings, ${r.keybindings} keybindings and ${r.themes.length} themes${
                r.skipped.length ? `; skipped ${r.skipped.map((x) => x.key ?? x.message).join(', ')}` : ''
              }.`;
            })
          }
        >
          Import settings…
        </button>
        <span className={s.spacer} />
        <button
          type="button"
          onClick={() =>
            void (async () => {
              if (
                !(await confirm(
                  'Reset all settings?',
                  'Every setting of this profile returns to its default. Keybindings, themes and profiles are kept.',
                  'Reset all',
                  true,
                ))
              )
                return;
              await run(async () => {
                await reset();
                push({ kind: 'success', title: 'Settings reset to defaults' });
                return null;
              });
            })()
          }
        >
          Reset all settings…
        </button>
      </div>
      {msg && (
        <p className={msg.ok ? s.ok : s.error} role={msg.ok ? 'status' : 'alert'}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

/** Preferences › Experimental: toggles for known experiments (stored in `experimental.flags`). */
export function ExperimentalSection() {
  const flags = useSetting('experimental.flags') ?? [];
  const set = useSettingsStore((st) => st.set);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: ExperimentId, on: boolean): void => {
    const next = on ? [...new Set([...flags, id])] : flags.filter((f) => f !== id);
    set('experimental.flags', next).catch((e: unknown) => setError(errorText(e)));
  };
  return (
    <div className={s.group}>
      {EXPERIMENTS.map((x) => (
        <div key={x.id} className={s.row} data-experiment={x.id}>
          <div className={s.rowText}>
            <label htmlFor={`exp-${x.id}`} className={s.rowTitle}>
              {x.title}
              <ScopeBadge scope="app" />
              <span className={s.badgeWarn}>Experimental</span>
            </label>
            <p className={s.rowDesc}>{x.description}</p>
            <span className={s.rowKey}>experimental.flags: {x.id}</span>
          </div>
          <div className={s.control}>
            <input
              id={`exp-${x.id}`}
              type="checkbox"
              role="switch"
              className={s.toggle}
              checked={hasExperiment(flags, x.id)}
              onChange={(e) => toggle(x.id, e.target.checked)}
            />
          </div>
          <span />
        </div>
      ))}
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
