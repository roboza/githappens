import { spawn } from 'node:child_process';

import type { Launch } from './launch';

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Start a GUI tool / terminal detached from the app (it outlives GitHappens). Resolves once it has started. */
export function spawnDetached(l: Launch, o: SpawnOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(l.file, l.args, {
      cwd: o.cwd,
      env: o.env,
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: false,
      windowsVerbatimArguments: !!l.verbatim,
    });
    child.once('error', (e) => reject(new Error(`Could not start ${l.file}: ${e.message}`, { cause: e })));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Start a tool and wait for it to exit (external merge tool). Aborting stops waiting, not the tool. */
export function spawnAndWait(
  l: Launch,
  o: SpawnOptions & { signal?: AbortSignal } = {},
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return resolve(null);
    const child = spawn(l.file, l.args, {
      cwd: o.cwd,
      env: o.env,
      stdio: 'ignore',
      shell: false,
      windowsHide: false,
      windowsVerbatimArguments: !!l.verbatim,
    });
    const onAbort = (): void => {
      child.unref();
      resolve(null);
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', (e) => {
      o.signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Could not start ${l.file}: ${e.message}`, { cause: e }));
    });
    child.once('close', (code) => {
      o.signal?.removeEventListener('abort', onAbort);
      resolve(code);
    });
  });
}
