import type { AgentsEventContract, AgentsIpcContract } from '../../shared/ipc/agents-contract';
import type { SettingValue } from '../../shared/settings/registry';
import { AgentMonitor } from '../agents/agent-monitor';
import { pathGitExec, readSetupCommands, writeSetupCommands, type GitExec } from '../agents/agent-setup';
import { createProcessProbe, type ProcessProbe } from '../agents/process-probe';
import type { PtyService } from '../services/pty-service';
import type { HandlerContext } from './registry';

export type AgentsHandlers = {
  [C in keyof AgentsIpcContract]: (
    req: AgentsIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => AgentsIpcContract[C]['res'] | Promise<AgentsIpcContract[C]['res']>;
};

type AgentSettingKey = 'tools.agentCommand' | 'tools.agentArgs';

export interface AgentsHandlerDeps {
  ptys: PtyService;
  /** Main-process settings store (reads `tools.agentCommand` / `tools.agentArgs`). */
  settings: { get<K extends AgentSettingKey>(key: K): SettingValue<K> };
  /** Send `agents:changed` to every window. */
  broadcast(event: 'agents:changed', payload: AgentsEventContract['agents:changed']): void;
  /** Override OS process inspection (tests); `null` disables it. */
  probe?: ProcessProbe | null;
  platform?: NodeJS.Platform;
  /** Use a pre-built monitor (tests); the deps above are then only used for validation. */
  monitor?: AgentMonitor;
  /** Git for `githappens.agentSetup` (default: `git` on PATH). */
  git?: GitExec;
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`Invalid ${name}`);
  return v;
}

function optStrArr(v: unknown, name: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((a) => typeof a !== 'string')) throw new Error(`Invalid ${name}`);
  return v as string[];
}

function optNum(v: unknown, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Invalid ${name}`);
  return v;
}

/** Agent Sessions IPC (spec 12 §4.12). Sessions are scoped to the calling window's terminals. */
export function createAgentsHandlers(deps: AgentsHandlerDeps): AgentsHandlers {
  const platform = deps.platform ?? process.platform;
  const git = deps.git ?? pathGitExec;
  const monitor =
    deps.monitor ??
    new AgentMonitor({
      ptys: deps.ptys,
      agentCommand: () => deps.settings.get('tools.agentCommand'),
      agentArgs: () => deps.settings.get('tools.agentArgs'),
      emit: (payload) => deps.broadcast('agents:changed', payload),
      probe: deps.probe === null ? undefined : (deps.probe ?? createProcessProbe(platform)),
      platform,
      git,
    });
  return {
    'agents:list': (req, { senderId }) => {
      const paths = optStrArr(req.worktreePaths, 'worktreePaths') ?? [];
      return monitor.list(senderId, paths, req.external === true);
    },
    'agents:start': (req, { senderId }) =>
      monitor.start(senderId, {
        cwd: str(req.cwd, 'cwd'),
        command: req.command === undefined ? undefined : str(req.command, 'command'),
        args: optStrArr(req.args, 'args'),
        cols: optNum(req.cols, 'cols'),
        rows: optNum(req.rows, 'rows'),
        setup: req.setup === 'force' || req.setup === 'skip' ? req.setup : 'auto',
      }),
    'agents:stop': (req, { senderId }) => monitor.stop(senderId, str(req.ptyId, 'ptyId'), req.force === true),
    'agents:setup:get': (req) => readSetupCommands(git, str(req.repoPath, 'repoPath')),
    'agents:setup:set': (req) =>
      writeSetupCommands(git, str(req.repoPath, 'repoPath'), optStrArr(req.commands, 'commands') ?? []),
  };
}
