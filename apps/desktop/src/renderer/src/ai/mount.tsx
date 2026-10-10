import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Render a self-contained dialog into its own root and resolve with its result. Used by AI dialogs
 * opened from actions (consent, stash message, changelog) without a host component in the app shell.
 * The dialogs only use IPC and CSS variables, so they need no React context from the main tree.
 */
export function mountDialog<T>(render: (done: (value: T) => void) => ReactNode): Promise<T> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  return new Promise<T>((resolve) => {
    let finished = false;
    const done = (value: T): void => {
      if (finished) return;
      finished = true;
      resolve(value);
      queueMicrotask(() => {
        root.unmount();
        host.remove();
      });
    };
    root.render(render(done));
  });
}
