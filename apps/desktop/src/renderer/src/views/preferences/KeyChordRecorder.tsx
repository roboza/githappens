import { useEffect, useRef, useState } from 'react';

import { eventToChord, formatChord } from '../../commands/keybindings';
import { isMacPlatform, useKeybindingsStore } from '../../commands/keybindings-store';
import s from './PreferencesView.module.css';

/**
 * Captures one key chord (spec 13 §4.1 `KeyChordRecorder`). While mounted the global shortcut
 * dispatcher is paused. Esc cancels; Backspace alone clears (records nothing).
 */
export function KeyChordRecorder({
  onRecord,
  onCancel,
  label = 'Press keys…',
}: {
  onRecord(chord: string): void;
  onCancel(): void;
  label?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [live, setLive] = useState('');
  const isMac = isMacPlatform();

  useEffect(() => {
    useKeybindingsStore.getState().setRecording(true);
    ref.current?.focus();
    return () => useKeybindingsStore.getState().setRecording(false);
  }, []);

  return (
    <span
      ref={ref}
      tabIndex={0}
      role="textbox"
      aria-label="Record key chord"
      className={s.recorder}
      onBlur={onCancel}
      onKeyDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const n = e.nativeEvent;
        if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
          onCancel();
          return;
        }
        const chord = eventToChord(n);
        if (!chord) {
          const mods = [n.ctrlKey && 'ctrl', n.altKey && 'alt', n.shiftKey && 'shift', n.metaKey && 'meta']
            .filter(Boolean)
            .join('+');
          setLive(mods ? `${formatChord(`${mods}+…`, isMac)}` : '');
          return;
        }
        onRecord(chord);
      }}
      onKeyUp={() => setLive('')}
    >
      {live || <span className={s.recorderHint}>{label}</span>}
    </span>
  );
}
