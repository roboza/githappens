import { Keyboard, Plus, RotateCcw, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { parseKeybindingOverrides } from '../../../../shared/settings/keybindings';
import { useCommands } from '../../commands';
import {
  bindingsFor,
  conflictsFor,
  defaultBindingsFor,
  findConflicts,
  formatChord,
  reservedReason,
  resetCommandBindings,
  setCommandBindings,
} from '../../commands/keybindings';
import { isMacPlatform, useKeybindingsStore } from '../../commands/keybindings-store';
import { invoke, IpcError } from '../../lib/api';
import { prefsInvoke } from '../../stores/settings';
import { KeyChordRecorder } from './KeyChordRecorder';
import s from './PreferencesView.module.css';

const errorText = (e: unknown): string =>
  e instanceof IpcError ? e.error.message : e instanceof Error ? e.message : String(e);

/** Keyboard Shortcuts section (spec 13 §4.2): rebind / add / remove / reset, conflicts, import / export. */
export function KeybindingsSection() {
  const commands = useCommands();
  const overrides = useKeybindingsStore((st) => st.overrides);
  const resolved = useKeybindingsStore((st) => st.resolved);
  const save = useKeybindingsStore((st) => st.save);
  const isMac = isMacPlatform();
  const [query, setQuery] = useState('');
  const [keyQuery, setKeyQuery] = useState<string | null>(null);
  const [recordingSearch, setRecordingSearch] = useState(false);
  const [recordingFor, setRecordingFor] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [importText, setImportText] = useState<string | null>(null);

  const titleOf = useMemo(() => new Map(commands.map((c) => [c.id, c.title])), [commands]);
  const conflictKeys = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const c of findConflicts(resolved)) m.set(c.key, c.commands);
    return m;
  }, [resolved]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...commands]
      .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title))
      .filter((c) => {
        const binds = bindingsFor(resolved, c.id);
        if (keyQuery) return binds.some((b) => b.key === keyQuery);
        if (!q) return true;
        const labels = binds.map((b) => formatChord(b.key, isMac).toLowerCase());
        return (
          c.title.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q) ||
          c.category.toLowerCase().includes(q) ||
          labels.some((l) => l.includes(q))
        );
      });
  }, [commands, resolved, query, keyQuery, isMac]);

  const persist = async (next: typeof overrides, ok?: string): Promise<void> => {
    try {
      await save(next);
      setMessage(ok ? { ok: true, text: ok } : null);
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    }
  };

  const addBinding = (command: string, chord: string): void => {
    setRecordingFor(null);
    const reserved = reservedReason(chord, isMac);
    if (reserved) {
      setMessage({ ok: false, text: reserved });
      return;
    }
    const current = bindingsFor(resolved, command);
    if (current.some((b) => b.key === chord)) return;
    const defaults = defaultBindingsFor(command, isMac);
    const when =
      defaults.length > 0 && defaults.every((d) => d.when === defaults[0]!.when)
        ? defaults[0]!.when
        : undefined;
    const others = conflictsFor(resolved, chord, command, when);
    const keys = [...current.map((b) => ({ key: b.key, when: b.when })), { key: chord, when }];
    void persist(
      setCommandBindings(overrides, command, keys),
      others.length
        ? `${formatChord(chord, isMac)} is also bound to ${others.map((o) => titleOf.get(o) ?? o).join(', ')}.`
        : undefined,
    );
  };

  const removeBinding = (command: string, chord: string): void => {
    const keys = bindingsFor(resolved, command)
      .filter((b) => b.key !== chord)
      .map((b) => ({ key: b.key, when: b.when }));
    void persist(setCommandBindings(overrides, command, keys));
  };

  return (
    <>
      <p className={s.intro}>
        Click + to record a new shortcut. Your changes are saved per profile in <code>keybindings.json</code>.
      </p>
      <div className={s.toolbar}>
        {recordingSearch ? (
          <KeyChordRecorder
            label="Press the shortcut to find…"
            onRecord={(c) => {
              setKeyQuery(c);
              setRecordingSearch(false);
            }}
            onCancel={() => setRecordingSearch(false)}
          />
        ) : keyQuery ? (
          <span className={s.kbd}>
            {formatChord(keyQuery, isMac)}
            <button
              type="button"
              className={s.kbdRemove}
              aria-label="Clear key search"
              onClick={() => setKeyQuery(null)}
            >
              <X size={12} />
            </button>
          </span>
        ) : (
          <input
            type="text"
            placeholder="Search commands or keys"
            aria-label="Search keybindings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        <button type="button" onClick={() => setRecordingSearch(true)} title="Search by pressing keys">
          <Keyboard size={14} /> Record keys
        </button>
        <span className={s.spacer} />
        <button
          type="button"
          onClick={() =>
            void invoke('shell:copyText', { text: JSON.stringify(overrides, null, 2) }).then(
              () => setMessage({ ok: true, text: 'Keybindings copied to the clipboard as JSON.' }),
              (e: unknown) => setMessage({ ok: false, text: errorText(e) }),
            )
          }
        >
          Export
        </button>
        <button type="button" onClick={() => setImportText(importText === null ? '' : null)}>
          Import…
        </button>
        <button
          type="button"
          onClick={() =>
            void prefsInvoke('keybindings:openJson', {}).catch((e: unknown) =>
              setMessage({ ok: false, text: errorText(e) }),
            )
          }
        >
          Open keybindings.json
        </button>
        <button
          type="button"
          disabled={overrides.length === 0}
          onClick={() => void persist([], 'All shortcuts reset.')}
        >
          Reset all
        </button>
      </div>

      {importText !== null && (
        <div className={s.group}>
          <textarea
            className={s.textarea}
            rows={6}
            aria-label="Keybindings JSON to import"
            placeholder='[{ "command": "branch.create", "key": "ctrl+shift+b" }]'
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <div className={s.toolbar} style={{ marginTop: 8 }}>
            <button
              type="button"
              className="primary"
              onClick={() => {
                let raw: unknown;
                try {
                  raw = JSON.parse(importText);
                } catch (e) {
                  setMessage({ ok: false, text: `Not valid JSON: ${(e as Error).message}` });
                  return;
                }
                const r = parseKeybindingOverrides(raw);
                if (!r.ok) {
                  setMessage({ ok: false, text: r.error });
                  return;
                }
                setImportText(null);
                void persist(r.value, `Imported ${r.value.length} keybinding entries.`);
              }}
            >
              Import (replaces current)
            </button>
            <button type="button" onClick={() => setImportText(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {message && (
        <p className={message.ok ? s.ok : s.error} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}

      <table className={s.kbTable}>
        <thead>
          <tr>
            <th>Command</th>
            <th>Category</th>
            <th>Keybinding</th>
            <th>Source</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const binds = bindingsFor(resolved, c.id);
            const userSet = overrides.some((o) => o.command === c.id);
            const conflicted = binds.filter((b) => (conflictKeys.get(b.key)?.length ?? 0) > 1);
            return (
              <tr key={c.id} className={conflicted.length ? s.kbRowConflict : undefined}>
                <td>
                  <div>{c.title}</div>
                  <div className={s.rowKey}>{c.id}</div>
                </td>
                <td className={s.muted}>{c.category}</td>
                <td>
                  <div className={s.chips}>
                    {binds.map((b) => {
                      const others = (conflictKeys.get(b.key) ?? []).filter((x) => x !== c.id);
                      return (
                        <span
                          key={`${b.key}|${b.when ?? ''}`}
                          className={s.kbd}
                          title={
                            [
                              b.when ? `When: ${b.when}` : '',
                              others.length
                                ? `Conflicts with: ${others.map((o) => titleOf.get(o) ?? o).join(', ')}`
                                : '',
                            ]
                              .filter(Boolean)
                              .join('\n') || undefined
                          }
                        >
                          {formatChord(b.key, isMac)}
                          {others.length > 0 && <span className={s.danger}>!</span>}
                          <button
                            type="button"
                            className={s.kbdRemove}
                            aria-label={`Remove ${formatChord(b.key, isMac)} from ${c.title}`}
                            onClick={() => removeBinding(c.id, b.key)}
                          >
                            <X size={12} />
                          </button>
                        </span>
                      );
                    })}
                    {recordingFor === c.id ? (
                      <KeyChordRecorder
                        onRecord={(chord) => addBinding(c.id, chord)}
                        onCancel={() => setRecordingFor(null)}
                      />
                    ) : (
                      <button
                        type="button"
                        className={s.iconButton}
                        aria-label={`Add keybinding for ${c.title}`}
                        title="Add keybinding"
                        onClick={() => setRecordingFor(c.id)}
                      >
                        <Plus size={12} />
                      </button>
                    )}
                  </div>
                </td>
                <td className={s.muted}>{userSet ? 'User' : binds.length ? 'Default' : ''}</td>
                <td>
                  {userSet && (
                    <button
                      type="button"
                      className={s.reset}
                      title="Reset to default"
                      aria-label={`Reset ${c.title} keybindings`}
                      onClick={() => void persist(resetCommandBindings(overrides, c.id))}
                    >
                      <RotateCcw size={14} />
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <p className={s.empty}>No commands match.</p>}
    </>
  );
}
