import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { findOnPath, GitProcessRunner, GitService } from '../src';
import { parseSignatureLog, verifyCommits } from '../src/service/signature';

describe('parseSignatureLog', () => {
  it('parses %G? records with signer and key', () => {
    const out = parseSignatureLog(
      '\x1eaaa\x1fG\x1fAlice <a@x>\x1fSHA256:abc\n\x1ebbb\x1fN\x1f\x1f\n\x1eccc\x1fE\x1f\x1f0123456789ABCDEF\n',
    );
    expect(out.aaa).toEqual({ code: 'G', signer: 'Alice <a@x>', key: 'SHA256:abc', format: 'ssh' });
    expect(out.bbb).toEqual({ code: 'N' });
    expect(out.ccc).toMatchObject({ code: 'E', format: 'openpgp' });
  });
});

const sshKeygen = findOnPath('ssh-keygen');
const gitPath = findOnPath('git');

(sshKeygen && gitPath ? describe : describe.skip)('verifyCommits (SSH signing, real git)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-sig-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reports G for a signed commit and N for an unsigned one', async () => {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    const key = path.join(dir, 'id_ed25519');
    execFileSync(sshKeygen!, ['-q', '-t', 'ed25519', '-N', '', '-C', 'test@example.com', '-f', key]);
    const pub = fs.readFileSync(`${key}.pub`, 'utf8').trim();
    const allowed = path.join(dir, 'allowed_signers');
    fs.writeFileSync(allowed, `test@example.com namespaces="git" ${pub}\n`);
    const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'T');
    git('config', 'user.email', 'test@example.com');
    git('config', 'gpg.format', 'ssh');
    git('config', 'user.signingkey', `${key}.pub`);
    git('config', 'gpg.ssh.allowedSignersFile', allowed);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git('add', '.');
    git('commit', '-q', '--no-gpg-sign', '-m', 'unsigned');
    const unsigned = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'b\n');
    git('commit', '-q', '-a', '-S', '-m', 'signed');
    const signed = git('rev-parse', 'HEAD');

    const runner = new GitProcessRunner({
      context: () => ({ gitPath: gitPath!, baseEnv: process.env, bundled: false }),
    });
    const service = await GitService.open(runner, repo);
    try {
      const r = await verifyCommits(service, [signed, unsigned]);
      expect(r[signed]?.code).toBe('G');
      expect(r[signed]?.format).toBe('ssh');
      expect(r[unsigned]?.code).toBe('N');
    } finally {
      service.dispose();
    }
  });
});
