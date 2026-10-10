import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Kill a git process and all of its children (ssh, git-remote-https, hooks).
 * Spec 02 §6.2: POSIX → signal the process group (spawned detached); Windows → taskkill /T /F.
 */
export function killProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32') {
    const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    tk.on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}
