import type { ToolsIpcContract } from '../../shared/ipc/tools-contract';
import type { ToolsService } from '../tools/tools-service';
import type { HandlerContext } from './registry';

export type ToolsHandlers = {
  [C in keyof ToolsIpcContract]: (
    req: ToolsIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => ToolsIpcContract[C]['res'] | Promise<ToolsIpcContract[C]['res']>;
};

/** External tools / "Open in…" IPC (spec 12 §6.10, spec 07 §6.9, spec 08 §6.8). */
export function createToolsHandlers(tools: ToolsService): ToolsHandlers {
  return {
    'tools:detect': ({ refresh }) => tools.detect(!!refresh),
    'tools:test': ({ kind }) => tools.test(kind),
    'open:editor': ({ path, repoId, line }) => tools.openEditor({ path, repoId }, line),
    'open:terminal': ({ cwd, repoId }) => tools.openTerminal(cwd, repoId),
    'open:fileManager': (ref) => tools.openFileManager(ref),
    'open:default': (ref) => tools.openDefault(ref),
    'tools:resolvePath': ({ repoId, path }) => ({ path: tools.resolvePath({ repoId, path }) }),
    'tools:openDiff': (req) => tools.openDiff(req),
    'tools:mergeTool': (req) => tools.mergeTool(req),
    'tools:mergeTool:cancel': ({ waitId }) => tools.cancelMergeTool(waitId),
  };
}
