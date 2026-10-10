import { execFile } from 'node:child_process';
import fs from 'node:fs';

import { parseCimProcesses, parseLsofCwd, parsePsOutput, type ProcInfo } from './agent-detect';

/**
 * Best-effort OS process inspection for the Agents view. Every call uses `execFile` with an
 * argv array (no shell) and a timeout; any failure yields an empty result.
 */
export interface ProcessProbe {
  /** All processes with parent ids and command lines. */
  list(): Promise<ProcInfo[]>;
  /** Working directories of the given pids (unsupported on Windows → empty map). */
  cwds(pids: number[]): Promise<Map<number, string>>;
}

export type ExecFileFn = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number; windowsHide: boolean },
) => Promise<string>;

const defaultExec: ExecFileFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...opts, encoding: 'utf8' }, (err, stdout) =>
      err ? reject(Object.assign(err, { stdout })) : resolve(stdout),
    );
  });

/** PowerShell script (constant: no user data is interpolated). */
export const CIM_SCRIPT =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';

export function createProcessProbe(
  platform: NodeJS.Platform = process.platform,
  exec: ExecFileFn = defaultExec,
  readlink: (p: string) => string = (p) => fs.readlinkSync(p),
): ProcessProbe {
  const opts = { timeout: 8000, maxBuffer: 16 * 1024 * 1024, windowsHide: true };
  return {
    async list() {
      try {
        if (platform === 'win32') {
          const out = await exec(
            'powershell.exe',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', CIM_SCRIPT],
            opts,
          );
          return parseCimProcesses(out);
        }
        return parsePsOutput(await exec('ps', ['-A', '-o', 'pid=,ppid=,args='], opts));
      } catch {
        return [];
      }
    },
    async cwds(pids) {
      const out = new Map<number, string>();
      const valid = pids.filter((p) => Number.isInteger(p) && p > 0);
      if (!valid.length || platform === 'win32') return out;
      if (platform === 'linux') {
        for (const pid of valid) {
          try {
            out.set(pid, readlink(`/proc/${pid}/cwd`));
          } catch {
            // gone or not ours
          }
        }
        return out;
      }
      try {
        return parseLsofCwd(await exec('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', valid.join(',')], opts));
      } catch (e) {
        // lsof exits 1 when some pids are gone but still prints the rest.
        const stdout = (e as { stdout?: unknown }).stdout;
        return typeof stdout === 'string' ? parseLsofCwd(stdout) : out;
      }
    },
  };
}
