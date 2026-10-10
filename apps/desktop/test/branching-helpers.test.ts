import { describe, expect, it } from 'vitest';

import {
  caseOnlyWarning,
  isChain,
  normalizeRefInput,
  refNameProblem,
} from '../src/renderer/src/views/ops/ref-names';

describe('ref name checks (spec 05 §4.3, §8)', () => {
  const existing = ['main', 'feature', 'release/1.0'];
  const check = (n: string, caseInsensitive = false) => refNameProblem(n, existing, { caseInsensitive });

  it('rejects git-invalid names with readable reasons', () => {
    expect(check('')).toMatch(/Enter a branch name/);
    expect(check('a..b')).toMatch(/\.\./);
    expect(check('a@{b')).toMatch(/@\{/);
    expect(check('x.lock')).toMatch(/\.lock/);
    expect(check('-x')).toMatch(/cannot start/);
    expect(check('a b')).toMatch(/character/);
    expect(check('a/')).toMatch(/empty path segment/);
    expect(check('a/.b')).toMatch(/cannot start with "\."/);
    expect(check('ok/name-1')).toBeNull();
    expect(check('ünïcødé')).toBeNull();
  });

  it('reports existing names, file/directory clashes and case-only clashes', () => {
    expect(check('main')).toMatch(/already exists/);
    expect(check('feature/x')).toMatch(/"feature" exists/);
    expect(check('release')).toMatch(/"release\/1.0" exists/);
    expect(check('Main', true)).toMatch(/differs only in case/);
    expect(check('Main', false)).toBeNull();
    expect(caseOnlyWarning('Main', existing)).toMatch(/differs only in case/);
    expect(caseOnlyWarning('main', existing)).toBeNull();
    expect(refNameProblem('v1', ['v1'], { caseInsensitive: false, kind: 'tag' })).toBe('Tag already exists.');
  });

  it('turns spaces into dashes while typing', () => {
    expect(normalizeRefInput('my new branch')).toBe('my-new-branch');
    expect(normalizeRefInput('tab\there')).toBe('tab-here');
  });
});

describe('multi-commit selection (spec 05 §4.2)', () => {
  it('detects a contiguous first-parent chain (newest first)', () => {
    const c = (sha: string, ...parents: string[]) => ({ sha, parents });
    expect(isChain([c('c', 'b'), c('b', 'a'), c('a', 'root')])).toBe(true);
    expect(isChain([c('c', 'b'), c('a', 'root')])).toBe(false);
    expect(isChain([c('m', 'x', 'b'), c('b', 'a')])).toBe(false);
    expect(isChain([])).toBe(false);
  });
});
