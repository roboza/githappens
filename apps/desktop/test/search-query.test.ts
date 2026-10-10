import { GraphModel } from '@githappens/graph';
import type { CommitSummary } from '@githappens/git/types';
import { describe, expect, it } from 'vitest';

import { collapseParents, filteredGraphModel } from '../src/renderer/src/views/graph/search-filter';
import {
  matchesCommit,
  parseQuery,
  tokenize,
  toSearchQuery,
} from '../src/renderer/src/views/graph/search-query';

const commit = (sha: string, parents: string[], subject: string, author = 'Alice Smith'): CommitSummary => ({
  sha,
  parents,
  authorName: author,
  authorEmail: `${author.split(' ')[0]!.toLowerCase()}@x.com`,
  authorTime: 0,
  committerName: author,
  committerEmail: '',
  commitTime: 0,
  subject,
});

describe('graph search query (spec 12 §11)', () => {
  it('tokenizes on spaces, keeping quoted strings and /regex/ together', () => {
    expect(tokenize('  fix   bug ')).toEqual(['fix', 'bug']);
    expect(tokenize('"fix bug" parser')).toEqual(['"fix bug"', 'parser']);
    expect(tokenize('@"Ann Lee" file:"my dir/x"')).toEqual(['@"Ann Lee"', 'file:"my dir/x"']);
    expect(tokenize('/fix(es)? bug/ x')).toEqual(['/fix(es)? bug/', 'x']);
    expect(tokenize('a/b c')).toEqual(['a/b', 'c']);
    expect(tokenize('"unterminated phrase')).toEqual(['"unterminated phrase']);
  });

  it('parses every prefix', () => {
    const terms = (s: string) => parseQuery(s).terms;
    expect(terms('fix')).toEqual([{ field: 'any', text: 'fix', regex: false }]);
    expect(terms('@bob')).toEqual([{ field: 'author', text: 'bob', regex: false }]);
    expect(terms('#abc1')).toEqual([{ field: 'sha', text: 'abc1', regex: false }]);
    expect(terms('FILE:src/*.ts')).toEqual([{ field: 'path', text: 'src/*.ts', regex: false }]);
    expect(terms('~needle')).toEqual([{ field: 'content', text: 'needle', regex: false }]);
    expect(terms('=ne+dle')).toEqual([{ field: 'content', text: 'ne+dle', regex: true }]);
    expect(terms('/^fix:/')).toEqual([{ field: 'message', text: '^fix:', regex: true }]);
    expect(terms('@me')).toEqual([{ field: 'author', text: 'me', regex: false }]);
    expect(parseQuery('@me', { me: 'me@x.com' }).terms[0]!.text).toBe('me@x.com');
    expect(terms('@')).toEqual([]);
  });

  it('treats unknown prefixes and quoted prefixes as plain text', () => {
    expect(parseQuery('foo:bar').terms).toEqual([{ field: 'any', text: 'foo:bar', regex: false }]);
    expect(parseQuery('"@bob"').terms).toEqual([{ field: 'any', text: '@bob', regex: false }]);
    expect(parseQuery('"fix bug"').terms).toEqual([{ field: 'any', text: 'fix bug', regex: false }]);
    expect(parseQuery('say \\"hi\\"').terms.map((t) => t.text)).toEqual(['say', '"hi"']);
  });

  it('computes fields, deep and errors', () => {
    expect(parseQuery('fix @bob').fields.sort()).toEqual(['author', 'message', 'sha']);
    expect(parseQuery('fix @bob').deep).toBe(false);
    expect(parseQuery('file:x').deep).toBe(true);
    expect(parseQuery('~x').deep).toBe(true);
    expect(parseQuery('#main').deep).toBe(true);
    expect(parseQuery('#abc').deep).toBe(false);
    expect(parseQuery('/(unclosed/').error).toMatch(/Invalid regular expression/);
    expect(parseQuery('~a ~b').error).toMatch(/one ~ or =/);
    expect(parseQuery('file:a file:b').error).toMatch(/one file:/);
    expect(parseQuery('fix').error).toBeNull();
  });

  it('matches loaded commits: every term must match (AND)', () => {
    const c = commit('abcdef12', [], 'Fix bug in parser', 'Bob Jones');
    const m = (s: string) => matchesCommit(c, parseQuery(s));
    expect(m('fix')).toBe(true);
    expect(m('fix parser')).toBe(true);
    expect(m('fix lexer')).toBe(false);
    expect(m('"bug in"')).toBe(true);
    expect(m('"in bug"')).toBe(false);
    expect(m('@jones fix')).toBe(true);
    expect(m('@alice fix')).toBe(false);
    expect(m('#abcd')).toBe(true);
    expect(m('#abcd @bob')).toBe(true);
    expect(m('/^fix\\s+bug/')).toBe(true);
    expect(m('/^bug/')).toBe(false);
    expect(m('~needle')).toBe(false); // content needs deep search
    expect(m('/(bad/')).toBe(false);
    expect(m('')).toBe(false);
  });

  it('builds the graph:search request', () => {
    expect(toSearchQuery(parseQuery('/^fix/ @bob'), { searchId: 's1' })).toEqual({
      kind: 'message',
      text: '^fix',
      terms: [
        { field: 'message', text: '^fix', regex: true },
        { field: 'author', text: 'bob', regex: false },
      ],
      searchId: 's1',
    });
    expect(toSearchQuery(parseQuery('=x+')).kind).toBe('regex');
    expect(toSearchQuery(parseQuery('file:a')).kind).toBe('file');
  });
});

describe('search filter mode (hide non-matching rows)', () => {
  // a ← b ← c ← d (linear), e merges d and side branch f ← a
  const commits = [
    commit('e', ['d', 'f'], 'merge'),
    commit('f', ['a'], 'side match'),
    commit('d', ['c'], 'match d'),
    commit('c', ['b'], 'other'),
    commit('b', ['a'], 'other'),
    commit('a', [], 'root match'),
  ];

  it('collapses parents to the nearest visible ancestors', () => {
    const vis = new Set(['d', 'f', 'a']);
    const p = collapseParents(commits, (s) => vis.has(s));
    expect([...p.keys()].sort()).toEqual(['a', 'd', 'f']);
    expect(p.get('d')).toEqual(['a']);
    expect(p.get('f')).toEqual(['a']);
    expect(p.get('a')).toEqual([]);
    const withMerge = collapseParents(commits, (s) => s === 'e' || s === 'a');
    expect(withMerge.get('e')).toEqual(['a']); // both paths end at a (deduped)
  });

  it('lays out only matching rows, keeping real parents on the items', () => {
    const full = new GraphModel<CommitSummary>({ headSha: 'e' });
    full.append(commits, true);
    const vis = new Set(['d', 'f', 'a']);
    const m = filteredGraphModel(full, (s) => vis.has(s));
    expect(m.rowCount).toBe(3);
    expect([0, 1, 2].map((r) => m.shaAt(r))).toEqual(['f', 'd', 'a']);
    expect(m.parentRows(m.rowOf('d'))).toEqual([m.rowOf('a')]);
    expect(m.commitAt(m.rowOf('d'))!.parents).toEqual(['c']);
    expect(m.headSha).toBeNull();
    expect(full.rowCount).toBe(6);
  });
});
