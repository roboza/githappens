import { describe, expect, it } from 'vitest';

import { lockDialogText } from '../src/renderer/src/lib/lock-dialog';

/** Lock dialog copy (spec 02 §4 "Lock dialog", §6.13 rule 3 stale heuristic). */
describe('lockDialogText', () => {
  it('names the lock and its age, and says when it looks stale', () => {
    expect(lockDialogText({ lockPath: 'C:\\r\\.git\\index.lock', ageSec: 180, stale: 1 })).toBe(
      'A git lock file exists (.git/index.lock, created 3 min ago). No Git process seems to be using this repository, so the lock looks stale and can be deleted.',
    );
    expect(lockDialogText({ lockPath: '/r/.git/HEAD.lock', ageSec: 12, stale: 0 })).toMatch(
      /^A git lock file exists \(\.git\/HEAD\.lock, created 12 s ago\)\. Another Git process may be running\./,
    );
    expect(lockDialogText({ lockPath: '/r/.git/refs/heads/x.lock' })).toMatch(/\(heads\/x\.lock\)/);
  });
});
