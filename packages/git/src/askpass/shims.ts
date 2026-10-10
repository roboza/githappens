import fs from 'node:fs';
import path from 'node:path';

/**
 * Askpass shim scripts (spec 02 §6.3): `askpass.sh` / `askpass.cmd` run `<node> askpass-main.js <prompt>`.
 * In Electron, `nodeExecutable` is `process.execPath` with `ELECTRON_RUN_AS_NODE=1`.
 */
export interface AskpassShims {
  /** POSIX shell shim. Also what Git for Windows runs for GIT_ASKPASS (it honours the shebang). */
  shPath: string;
  /** Windows batch shim (for SSH_ASKPASS with Windows OpenSSH, which cannot run `.sh`). */
  cmdPath: string;
  /** The Node client script. */
  mainPath: string;
  /** Whether `ELECTRON_RUN_AS_NODE=1` must be set for `nodeExecutable`. */
  runAsNodeEnv: boolean;
}

export interface AskpassShimOptions {
  nodeExecutable: string;
  runAsNodeEnv?: boolean;
}

/** Client: connect to GITHAPPENS_ASKPASS_PIPE, send {token, prompt}, print the answer (exit 1 on cancel). */
export const ASKPASS_MAIN_SOURCE = `'use strict';
// GitHappens askpass client (spec 02 §6.3). Generated file; do not edit.
const net = require('net');
const pipe = process.env.GITHAPPENS_ASKPASS_PIPE;
const token = process.env.GITHAPPENS_ASKPASS_TOKEN;
if (!pipe || !token) process.exit(1);
let buf = '';
let done = false;
const finish = (code, answer) => {
  if (done) return;
  done = true;
  if (code === 0) process.stdout.write(answer + '\\n', () => process.exit(0));
  else process.exit(code);
};
const sock = net.connect(pipe, () => {
  sock.write(JSON.stringify({ token: token, prompt: process.argv[2] || '' }) + '\\n');
});
sock.setEncoding('utf8');
sock.on('data', (d) => {
  buf += d;
  const i = buf.indexOf('\\n');
  if (i < 0) return;
  let msg = null;
  try { msg = JSON.parse(buf.slice(0, i)); } catch (e) { msg = null; }
  sock.end();
  if (msg && msg.ok === true && typeof msg.answer === 'string') finish(0, msg.answer);
  else finish(1);
});
sock.on('error', () => finish(1));
sock.on('close', () => finish(1));
`;

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** MSYS sh accepts `C:/x/y`; backslashes would be escapes. */
const shPathOf = (p: string): string => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p);
const cmdQuote = (s: string): string => `"${s.replace(/"/g, '""').replace(/%/g, '%%')}"`;

export async function writeAskpassShims(dir: string, o: AskpassShimOptions): Promise<AskpassShims> {
  await fs.promises.mkdir(dir, { recursive: true });
  const mainPath = path.join(dir, 'askpass-main.js');
  const shPath = path.join(dir, 'askpass.sh');
  const cmdPath = path.join(dir, 'askpass.cmd');
  const runAsNode = !!o.runAsNodeEnv;
  // the client is CommonJS regardless of any package.json further up
  await fs.promises.writeFile(path.join(dir, 'package.json'), '{ "type": "commonjs" }\n');
  await fs.promises.writeFile(mainPath, ASKPASS_MAIN_SOURCE);
  const sh =
    '#!/bin/sh\n' +
    `${runAsNode ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}exec ${shQuote(shPathOf(o.nodeExecutable))} ${shQuote(shPathOf(mainPath))} "$@"\n`;
  await fs.promises.writeFile(shPath, sh, { mode: 0o755 });
  await fs.promises.chmod(shPath, 0o755);
  const cmd =
    '@echo off\r\n' +
    (runAsNode ? 'set ELECTRON_RUN_AS_NODE=1\r\n' : '') +
    `${cmdQuote(o.nodeExecutable)} ${cmdQuote(mainPath)} %*\r\n`;
  await fs.promises.writeFile(cmdPath, cmd);
  return { shPath, cmdPath, mainPath, runAsNodeEnv: runAsNode };
}
