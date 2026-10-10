import { describe, expect, it } from 'vitest';

import {
  addCoAuthor,
  cleanHookOutput,
  coAuthorsInText,
  commitAction,
  commitButtonLabel,
  formatCoAuthor,
  isPristine,
  parseCoAuthor,
  prefillFromMessage,
  signFlag,
  splitMessageText,
  splitPaste,
  stripCommentLines,
  summaryCounter,
  templateFields,
  trailersToAdd,
  type ComposerMode,
} from '../src/renderer/src/views/composer/helpers';

describe('summary counter (spec 06 §4.5)', () => {
  it.each([
    ['', 'ok', '0/72'],
    ['x'.repeat(50), 'ok', '50/72'],
    ['x'.repeat(51), 'warn', '51/72'],
    ['x'.repeat(72), 'warn', '72/72'],
    ['x'.repeat(73), 'over', '73/72'],
  ])('%#: length %s → %s', (summary, tone, text) => {
    const c = summaryCounter(summary);
    expect(c.tone).toBe(tone);
    expect(c.text).toBe(text);
  });

  it('counts code points, not UTF-16 units', () => {
    expect(summaryCounter('😀'.repeat(51)).text).toBe('51/72');
  });
});

describe('paste splitting', () => {
  const cur = { summary: '', description: '', selStart: 0, selEnd: 0 };

  it('leaves single-line pastes to the input', () => {
    expect(splitPaste('just one line', cur)).toBeNull();
  });

  it('first line → summary, rest → description', () => {
    expect(splitPaste('Fix login\n\nThe token was\nnot refreshed.\n', cur)).toEqual({
      summary: 'Fix login',
      description: 'The token was\nnot refreshed.',
      caret: 9,
    });
  });

  it('normalizes CRLF and skips leading blank lines', () => {
    expect(splitPaste('\r\n\r\nTitle\r\nBody\r\n', cur)).toEqual({
      summary: 'Title',
      description: 'Body',
      caret: 5,
    });
  });

  it('inserts at the selection and prepends to an existing description', () => {
    const r = splitPaste('fix: x\nmore', {
      summary: 'feat: TODO end',
      description: 'old body',
      selStart: 6,
      selEnd: 10,
    });
    expect(r).toEqual({ summary: 'feat: fix: x end', description: 'more\n\nold body', caret: 12 });
  });

  it('keeps the description when only the first line has content', () => {
    expect(splitPaste('Title\n\n', { ...cur, description: 'keep' })?.description).toBe('keep');
  });
});

describe('co-author trailers', () => {
  it('parses typed input', () => {
    expect(parseCoAuthor('Ada Lovelace <ada@example.com>')).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    expect(parseCoAuthor('  bob@example.org ')).toEqual({ name: 'bob', email: 'bob@example.org' });
    expect(parseCoAuthor('<x@y.z>')).toEqual({ name: 'x@y.z', email: 'x@y.z' });
    expect(parseCoAuthor('not an email')).toBeNull();
    expect(parseCoAuthor('a <b>')).toBeNull();
  });

  it('formats Name <email>', () => {
    expect(formatCoAuthor({ name: ' Ada ', email: ' ada@x.io ' })).toBe('Ada <ada@x.io>');
  });

  it('finds existing trailers (case-insensitive key)', () => {
    const text =
      'Body\n\nco-authored-by: Ada <ada@x.io>\nCo-Authored-By: Bob <bob@x.io>\nSigned-off-by: C <c@x.io>';
    expect(coAuthorsInText(text)).toEqual([
      { name: 'Ada', email: 'ada@x.io' },
      { name: 'Bob', email: 'bob@x.io' },
    ]);
  });

  it('never duplicates chips or trailers already in the description', () => {
    const chips = [
      { name: 'Ada', email: 'ADA@x.io' },
      { name: 'Bob', email: 'bob@x.io' },
      { name: 'Bob again', email: 'Bob@x.io' },
      { name: 'Empty', email: ' ' },
    ];
    expect(trailersToAdd('Co-authored-by: Ada <ada@x.io>', chips)).toEqual([
      { name: 'Bob', email: 'bob@x.io' },
    ]);
    expect(addCoAuthor([{ name: 'A', email: 'a@x.io' }], { name: 'A2', email: 'A@X.IO' })).toHaveLength(1);
    expect(addCoAuthor([], { name: 'A', email: 'a@x.io' })).toHaveLength(1);
  });
});

describe('templates and prefills', () => {
  const tpl = '# Summary (50 chars)\n\n# Why?\nWhy: \n\n# Ticket\nRefs: \n';

  it('strips # comment lines like --cleanup=strip', () => {
    expect(stripCommentLines(tpl)).toBe('Why:\n\nRefs:');
    expect(stripCommentLines('a\n#x\n\n\n\nb\n')).toBe('a\n\nb');
  });

  it('turns a template into composer fields', () => {
    expect(templateFields('feat: \n\nBody line\n', true)).toEqual({
      summary: 'feat:',
      description: 'Body line',
    });
    expect(templateFields(tpl, true)).toEqual({ summary: 'Why:', description: 'Refs:' });
    expect(templateFields(tpl, false).description).toContain('# Why?');
  });

  it('pristine = empty or exactly the template', () => {
    const t = { summary: 'feat:', description: 'Body' };
    expect(isPristine({ summary: '', description: '  ' }, t)).toBe(true);
    expect(isPristine({ summary: 'feat:', description: 'Body' }, t)).toBe(true);
    expect(isPristine({ summary: 'feat: x', description: 'Body' }, t)).toBe(false);
    expect(isPristine({ summary: 'x', description: '' }, null)).toBe(false);
  });

  it('prefills MERGE_MSG without the conflict comments', () => {
    const msg = "Merge branch 'feature' into main\n\n# Conflicts:\n#\tsrc/a.ts\n";
    expect(prefillFromMessage(msg)).toEqual({ summary: "Merge branch 'feature' into main", description: '' });
    expect(splitMessageText('S\n\n\nBody\n')).toEqual({ summary: 'S', description: 'Body' });
  });
});

describe('commit button (spec 06 §4.1, §6.8)', () => {
  const base: ComposerMode = {
    op: null,
    squash: false,
    amend: false,
    allowEmpty: false,
    stagedCount: 2,
    push: false,
  };
  it.each<[Partial<ComposerMode>, string, string]>([
    [{}, 'commit', 'Commit changes to 2 files'],
    [{ stagedCount: 1 }, 'commit', 'Commit changes to 1 file'],
    [{ push: true }, 'commit', 'Commit changes to 2 files and push'],
    [{ stagedCount: 0 }, 'commit', 'Stage files to commit'],
    [{ stagedCount: 0, allowEmpty: true }, 'commit', 'Create empty commit'],
    [{ amend: true }, 'commit', 'Amend previous commit'],
    [{ op: 'merge' }, 'merge.continue', 'Commit and Merge'],
    [{ op: 'merge', squash: true }, 'commit', 'Commit squashed changes'],
    [{ op: 'rebase' }, 'rebase.continue', 'Continue Rebase'],
    [{ op: 'cherry-pick' }, 'sequencer.continue', 'Continue Cherry-pick'],
    [{ op: 'revert' }, 'sequencer.continue', 'Continue Revert'],
  ])('%o → %s / %s', (patch, action, label) => {
    const m = { ...base, ...patch };
    expect(commitAction(m)).toBe(action);
    expect(commitButtonLabel(m)).toBe(label);
  });

  it('maps the Sign toggle to commit.create', () => {
    expect(signFlag('config')).toBe('config');
    expect(signFlag('on')).toBe('force');
    expect(signFlag('off')).toBe('off');
  });
});

describe('hook output', () => {
  it('drops ANSI escapes and collapses carriage-return progress', () => {
    expect(cleanHookOutput('\x1b[31merror\x1b[0m: bad\r\nlint 10%\rlint 100%\nok')).toBe(
      'error: bad\nlint 100%\nok',
    );
  });
});
