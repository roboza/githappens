import { describe, expect, it } from 'vitest';

import { ghostCandidates, groupRefPills, isDisplayableRef, type RefInput } from '../src';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function local(name: string, sha = A, extra: Partial<RefInput> = {}): RefInput {
  return { fullName: `refs/heads/${name}`, shortName: name, type: 'local', sha, isHead: false, ...extra };
}
function remote(name: string, sha = A, extra: Partial<RefInput> = {}): RefInput {
  return { fullName: `refs/remotes/${name}`, shortName: name, type: 'remote', sha, isHead: false, ...extra };
}
function tag(name: string, sha = A, extra: Partial<RefInput> = {}): RefInput {
  return { fullName: `refs/tags/${name}`, shortName: name, type: 'tag', sha, isHead: false, ...extra };
}

describe('groupRefPills (§4.5)', () => {
  it('combines a local branch with its upstream at the same commit', () => {
    const pills = groupRefPills([
      local('main', A, {
        isHead: true,
        upstream: { fullName: 'refs/remotes/origin/main', ahead: 0, behind: 2, gone: false },
      }),
      remote('origin/main'),
    ]).get(A)!;
    expect(pills).toHaveLength(1);
    expect(pills[0]).toMatchObject({
      kind: 'head',
      label: 'main',
      hasLocal: true,
      hasRemote: true,
      isCheckedOut: true,
      behind: 2,
      refs: ['refs/heads/main', 'refs/remotes/origin/main'],
    });
  });

  it('does not combine when the upstream points elsewhere; absorbs same-name remotes of other remotes', () => {
    const map = groupRefPills([
      local('dev', A, { upstream: 'refs/remotes/origin/dev' }),
      remote('origin/dev', B),
      remote('fork/dev', A),
    ]);
    expect(map.get(A)!.map((p) => [p.kind, p.label, p.refs.length])).toEqual([['local', 'dev', 2]]);
    expect(map.get(B)!.map((p) => [p.kind, p.label, p.hasLocal])).toEqual([['remote', 'origin/dev', false]]);
  });

  it('sorts HEAD branch, locals, remote-only, tags, stash; alphabetical within', () => {
    const pills = groupRefPills([
      tag('v2'),
      tag('v10'),
      remote('origin/zeta'),
      remote('origin/alpha'),
      local('b-local'),
      local('A-local'),
      local('zz', A, { isHead: true }),
      { fullName: 'refs/stash', shortName: 'stash', type: 'stash', sha: A },
    ]).get(A)!;
    expect(pills.map((p) => p.label)).toEqual([
      'zz',
      'A-local',
      'b-local',
      'origin/alpha',
      'origin/zeta',
      'v10',
      'v2',
      'stash',
    ]);
  });

  it('excludes hidden refs, refs/githappens/*, other refs, remote HEAD symrefs, prefetch and notes', () => {
    const refs: RefInput[] = [
      local('main'),
      local('secret'),
      { fullName: 'refs/githappens/undo/1', shortName: 'undo/1', type: 'other', sha: A },
      { fullName: 'refs/githappens/keep', shortName: 'keep', type: 'local', sha: A },
      remote('origin/HEAD', A, { symrefTarget: 'refs/remotes/origin/main' }),
      { fullName: 'refs/prefetch/remotes/origin/main', shortName: 'x', type: 'remote', sha: A },
      { fullName: 'refs/notes/commits', shortName: 'notes', type: 'other', sha: A },
      remote('origin/main'),
    ];
    const pills = groupRefPills(refs, { hidden: ['refs/heads/secret', 'refs/remotes/origin/main'] }).get(A)!;
    expect(pills.map((p) => p.fullName)).toEqual(['refs/heads/main']);
    expect(pills[0]!.hasRemote).toBe(false);
    expect(isDisplayableRef(refs[2]!)).toBe(false);
  });

  it('accepts spec 04 GraphRef shapes (kind instead of type)', () => {
    const pills = groupRefPills([
      {
        fullName: 'refs/heads/main',
        shortName: 'main',
        kind: 'head',
        sha: A,
        upstream: 'refs/remotes/origin/main',
      },
      {
        fullName: 'refs/remotes/origin/main',
        shortName: 'origin/main',
        kind: 'remote',
        remote: 'origin',
        sha: A,
      },
    ]).get(A)!;
    expect(pills).toHaveLength(1);
    expect(pills[0]!.kind).toBe('head');
  });

  it('adds detached HEAD and stash pills; annotated tags are flagged', () => {
    const map = groupRefPills(
      [
        tag('v1', B, { tagObjectSha: 'c'.repeat(40) }),
        { fullName: 'refs/stash', shortName: 'stash', type: 'stash', sha: B },
      ],
      {
        detachedHeadSha: B,
        stashes: [{ sha: A, index: 0, ref: 'stash@{0}', message: 'On main: wip' }],
      },
    );
    expect(map.get(B)!.map((p) => p.label)).toEqual(['HEAD', 'v1']);
    expect(map.get(B)![1]!.isAnnotatedTag).toBe(true);
    expect(map.get(A)!.map((p) => [p.kind, p.label])).toEqual([['stash', 'stash@{0}: On main: wip']]);
  });

  it('ghostCandidates keeps only branches', () => {
    const pills = groupRefPills([local('main', A, { isHead: true }), remote('origin/x'), tag('v1')]).get(A);
    expect(ghostCandidates(pills)).toEqual([
      { name: 'main', fullName: 'refs/heads/main', head: true },
      { name: 'origin/x', fullName: 'refs/remotes/origin/x', remote: true },
    ]);
  });
});
