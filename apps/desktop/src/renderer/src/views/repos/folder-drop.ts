import { useEffect, useState } from 'react';

import { openRepoWithRecovery } from './open-flow';

/**
 * Drag a folder from the OS onto the window → open it as a repo (spec 03 §4.3). Only drops nobody else
 * handled (in-app drag & drop calls preventDefault first) and that carry OS files are taken.
 *
 * Paths come from `window.api.pathForFile` (preload: `webUtils.getPathForFile`); without it the drop falls
 * through to Chromium, which navigates to the `file://` URL — main's `will-navigate` handler turns that into
 * an open request (see `main/repos/os-integration.ts droppedPathFromUrl`).
 */

type PathForFile = (f: File) => string;

const pathForFile = (): PathForFile | undefined =>
  (window.api as unknown as { pathForFile?: PathForFile }).pathForFile;

export function droppedPaths(dt: DataTransfer | null): string[] {
  const get = pathForFile();
  if (!dt || !get) return [];
  const out: string[] = [];
  for (const f of Array.from(dt.files)) {
    try {
      const p = get(f);
      if (p && !out.includes(p)) out.push(p);
    } catch {
      /* not a local file */
    }
  }
  return out;
}

const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types?.includes('Files');

/** Window-wide folder drop; returns true while OS files are dragged over the window (for an overlay). */
export function useFolderDrop(enabled = true): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!enabled || !pathForFile()) return;
    let depth = 0;
    const enter = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const overFn = (e: DragEvent): void => {
      if (!hasFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const drop = (e: DragEvent): void => {
      depth = 0;
      setOver(false);
      if (!hasFiles(e) || e.defaultPrevented) return;
      const paths = droppedPaths(e.dataTransfer);
      if (!paths.length) return;
      e.preventDefault();
      void (async () => {
        for (const p of paths.slice(0, 10)) await openRepoWithRecovery(p);
      })();
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overFn);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('drop', drop);
    };
  }, [enabled]);
  return over;
}
