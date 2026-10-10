import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IGNORE_FILE, IgnoreStore } from '../src/main/conflicts/ignore-store';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ignores-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('IgnoreStore', () => {
  it('persists rules in <commonDir>/githappens-conflicts.json', () => {
    new IgnoreStore().set(dir, { scope: 'file', value: 'a.txt' });
    expect(new IgnoreStore().list(dir)).toEqual([{ scope: 'file', value: 'a.txt' }]);
    expect(fs.existsSync(path.join(dir, IGNORE_FILE))).toBe(true);
  });
});
