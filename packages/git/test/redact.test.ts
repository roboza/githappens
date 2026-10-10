import { describe, expect, it } from 'vitest';

import { formatCommand, redact } from '../src';

describe('redact', () => {
  it('masks passwords in URLs but keeps the user', () => {
    expect(redact('fatal: unable to access https://bob:s3cret@github.com/a/b.git/')).toBe(
      'fatal: unable to access https://bob:***@github.com/a/b.git/',
    );
  });

  it('masks bare tokens used as the URL user', () => {
    expect(redact('https://ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/a/b')).toBe(
      'https://***@github.com/a/b',
    );
  });

  it('masks authorization headers and extraheader config', () => {
    expect(redact('Authorization: Bearer abc.def')).toBe('Authorization: Bearer ***');
    expect(redact('-c http.https://x/.extraheader=AUTHORIZATION: basic Zm9v')).toBe(
      '-c http.https://x/.extraheader=***',
    );
  });

  it('leaves normal text alone', () => {
    expect(redact('git@github.com:org/repo.git')).toBe('git@github.com:org/repo.git');
  });

  it('formats commands with quoting', () => {
    expect(formatCommand(['commit', '-m', 'hello world'])).toBe('git commit -m "hello world"');
  });
});
