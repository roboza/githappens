import type { UpdateIpcContract } from '../../shared/ipc/update-contract';
import type { UpdaterService } from '../services/updater';
import type { HandlerContext } from './registry';

export type UpdateHandlers = {
  [C in keyof UpdateIpcContract]: (
    req: UpdateIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => UpdateIpcContract[C]['res'] | Promise<UpdateIpcContract[C]['res']>;
};

type UpdaterLike = Pick<UpdaterService, 'current' | 'check' | 'installAndRestart' | 'whatsNew'>;

/** Auto-update IPC handlers (spec 15 §5). */
export function createUpdateHandlers(svc: UpdaterLike): UpdateHandlers {
  return {
    'update:status': () => svc.current,
    'update:check': () => svc.check(),
    'update:install': () => svc.installAndRestart(),
    'update:whatsNew': (req) => svc.whatsNew(req?.force === true),
  };
}
