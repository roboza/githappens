import type { TerminalIpcContract } from '../../shared/ipc/terminal-contract';
import type { PtyService } from '../services/pty-service';
import type { HandlerContext } from './registry';

export type TerminalHandlers = {
  [C in keyof TerminalIpcContract]: (
    req: TerminalIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => TerminalIpcContract[C]['res'] | Promise<TerminalIpcContract[C]['res']>;
};

function str(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`Invalid ${name}`);
  return v;
}

function strArr(v: unknown, name: string): string[] {
  if (!Array.isArray(v)) throw new Error(`Invalid ${name}`);
  return v.map((a) => str(a, name));
}

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Invalid ${name}`);
  return v;
}

/** Terminal IPC handlers (spec 12 §4.2). Every call is scoped to the calling window. */
export function createTerminalHandlers(svc: PtyService): TerminalHandlers {
  return {
    'terminal:create': (req, { senderId }) =>
      svc.create(senderId, {
        cwd: str(req.cwd, 'cwd'),
        cols: num(req.cols, 'cols'),
        rows: num(req.rows, 'rows'),
        shell: req.shell === undefined ? undefined : str(req.shell, 'shell'),
        args: req.args === undefined ? undefined : strArr(req.args, 'args'),
        repoPath: req.repoPath === undefined ? undefined : str(req.repoPath, 'repoPath'),
        shellIntegration: req.shellIntegration === true,
      }),
    'terminal:write': (req, { senderId }) => svc.write(senderId, str(req.id, 'id'), str(req.data, 'data')),
    'terminal:resize': (req, { senderId }) =>
      svc.resize(senderId, str(req.id, 'id'), num(req.cols, 'cols'), num(req.rows, 'rows')),
    'terminal:kill': (req, { senderId }) => svc.kill(senderId, str(req.id, 'id')),
    'terminal:ack': (req, { senderId }) => svc.ack(senderId, str(req.id, 'id'), num(req.chars, 'chars')),
    'terminal:list': (_req, { senderId }) => svc.list(senderId),
    'terminal:attach': (req, { senderId }) =>
      svc.attach(senderId, str(req.id, 'id'), num(req.cols, 'cols'), num(req.rows, 'rows')),
    'terminal:detach': (req, { senderId }) => svc.detach(senderId, str(req.id, 'id')),
    'terminal:listShells': () => svc.listShells(),
    'terminal:completionContext': (req) => svc.completionContext(str(req.cwd, 'cwd')),
  };
}
