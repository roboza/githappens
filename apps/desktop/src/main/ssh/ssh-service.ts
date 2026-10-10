import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

import type {
  GeneratedSshKey,
  SshKeyType,
  SshStatus,
  SshTestResult,
} from '../../shared/ipc/network-contract';
import {
  buildSshInvocation,
  probeSshHost,
  type SshHostInfo,
  type SshInvocation,
  type SshPrefs,
} from './ssh-command';
import { defaultKeyPath, expandHome, generateSshKey, readPublicKey, type PublicKeyInfo } from './ssh-keys';
import { parseSshTarget, parseSshTestOutput, sshTestArgs } from './ssh-test';
import { execTool, locateSshTool, type ExecResult } from './ssh-tools';

export interface SshServiceDeps {
  prefs: () => SshPrefs & { publicKeyPath: string };
  /** Store generated key paths (`ssh.privateKeyPath` / `ssh.publicKeyPath`). */
  setKeyPaths: (privateKeyPath: string, publicKeyPath: string) => void;
  /** Default key comment (profile email). */
  defaultComment: () => string;
  bundledGitDir?: string;
  /** Askpass env for an ad-hoc ssh run (host-key / passphrase prompts); `release` when done. */
  askpass?: { env: (opId: string) => Record<string, string>; release: (opId: string) => void };
  /** Test seams. */
  probe?: () => SshHostInfo;
  exec?: (file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<ExecResult>;
  locate?: (name: 'ssh' | 'ssh-keygen') => string | null;
}

const PROBE_TTL_MS = 5_000;
const TEST_TIMEOUT_MS = 120_000;

/** SSH key/agent selection for git (spec 09 §6.7), key generation and connection tests (spec 13). */
export class SshService {
  private cached: { at: number; host: SshHostInfo } | null = null;

  constructor(private readonly d: SshServiceDeps) {}

  /** Host facts are probed at most every few seconds (the invocation is built for every git spawn). */
  private host(): SshHostInfo {
    const now = Date.now();
    if (!this.cached || now - this.cached.at > PROBE_TTL_MS) {
      this.cached = { at: now, host: (this.d.probe ?? probeSshHost)() };
    }
    return this.cached.host;
  }

  /** Env additions for every git invocation. */
  invocation(): SshInvocation {
    return buildSshInvocation(this.d.prefs(), this.host());
  }

  private locate(name: 'ssh' | 'ssh-keygen'): string | null {
    return this.d.locate ? this.d.locate(name) : locateSshTool(name, { bundledGitDir: this.d.bundledGitDir });
  }

  status(): SshStatus {
    this.cached = null;
    const prefs = this.d.prefs();
    const inv = this.invocation();
    const priv = prefs.privateKeyPath.trim() ? expandHome(prefs.privateKeyPath) : '';
    const pub = this.publicKeyPathFor(prefs);
    const pipes = this.host().agentPipes;
    const keygenPath = this.locate('ssh-keygen');
    const warnings = [...inv.warnings];
    if (inv.mode === 'key' && priv && !fs.existsSync(priv)) warnings.push(`Private key not found: ${priv}`);
    if (!keygenPath) warnings.push('ssh-keygen was not found; key generation is unavailable.');
    return {
      mode: inv.mode,
      client: inv.client,
      sshCommand: typeof inv.env.GIT_SSH_COMMAND === 'string' ? inv.env.GIT_SSH_COMMAND : null,
      privateKeyPath: priv,
      publicKeyPath: pub,
      privateKeyExists: !!priv && fs.existsSync(priv),
      publicKeyExists: !!pub && fs.existsSync(pub),
      agentPipes: pipes ? { openssh: pipes.openssh, pageant: !!pipes.pageant } : null,
      keygenPath,
      defaultKeyPath: defaultKeyPath('ed25519'),
      defaultComment: this.d.defaultComment() || `${os.userInfo().username}@${os.hostname()}`,
      warnings,
    };
  }

  private publicKeyPathFor(prefs: { privateKeyPath: string; publicKeyPath: string }): string {
    if (prefs.publicKeyPath.trim()) return expandHome(prefs.publicKeyPath);
    return prefs.privateKeyPath.trim() ? `${expandHome(prefs.privateKeyPath)}.pub` : '';
  }

  async generate(req: {
    type: SshKeyType;
    comment?: string;
    passphrase?: string;
    path?: string;
    useAsDefault?: boolean;
  }): Promise<GeneratedSshKey> {
    const keygen = this.locate('ssh-keygen');
    if (!keygen)
      throw new Error('ssh-keygen was not found. Install OpenSSH (or Git for Windows) and try again.');
    const key = await generateSshKey({
      keygen,
      type: req.type,
      comment: req.comment?.trim() || this.status().defaultComment,
      passphrase: req.passphrase,
      path: req.path?.trim() || defaultKeyPath(req.type),
    });
    if (req.useAsDefault) this.d.setKeyPaths(key.privateKeyPath, key.publicKeyPath);
    this.cached = null;
    return key;
  }

  async publicKey(p?: string): Promise<PublicKeyInfo & { path: string }> {
    const target = p?.trim() ? expandHome(p) : this.publicKeyPathFor(this.d.prefs());
    if (!target) throw new Error('No SSH public key is configured.');
    const file = target.endsWith('.pub') || fs.existsSync(target) ? target : `${target}.pub`;
    return { ...(await readPublicKey(file)), path: file };
  }

  /** `ssh -T <user>@<host>` with the same selection git uses (spec 13 `ssh:testConnection`). */
  async testConnection(hostInput: string): Promise<SshTestResult> {
    const target = parseSshTarget(hostInput);
    const inv = this.invocation();
    const exe = inv.argv.exe ?? this.locate('ssh');
    if (!exe) {
      return { ok: false, kind: 'notFound', message: 'No ssh client was found.', output: '' };
    }
    const opId = `ssh-test-${randomUUID()}`;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(inv.env)) {
      if (k === 'GIT_SSH_COMMAND') continue;
      if (v === null) delete env[k];
      else env[k] = v;
    }
    Object.assign(env, this.d.askpass?.env(opId) ?? {});
    const args = [...inv.argv.args, ...sshTestArgs(target)];
    try {
      const exec =
        this.d.exec ??
        ((f: string, a: string[], e: NodeJS.ProcessEnv, t: number) =>
          execTool(f, a, { env: e, timeoutMs: t }));
      const r = await exec(exe, args, env, TEST_TIMEOUT_MS);
      return parseSshTestOutput(`${r.stderr}\n${r.stdout}`, r.exitCode, { timedOut: r.timedOut });
    } finally {
      this.d.askpass?.release(opId);
    }
  }
}
