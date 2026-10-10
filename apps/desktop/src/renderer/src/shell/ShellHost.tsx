import { GitNotFound } from './GitNotFound';
import { ShortcutsOverlay } from './ShortcutsOverlay';

/**
 * Shell-level overlays (spec 01): the Keyboard Shortcuts overlay and the blocking "Git not found" state.
 * Mount once in App, after the main layout. Menu / window-state / shortcut wiring lives in `useShortcuts`.
 */
export function ShellHost() {
  return (
    <>
      <ShortcutsOverlay />
      <GitNotFound />
    </>
  );
}
