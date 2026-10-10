import type { SuggestIpcContract } from '../../shared/ipc/suggest-contract';
import type { SuggestService } from '../cloud/suggest';
import { toPatchError } from './patches-handlers';
import type { HandlerContext } from './registry';

export type SuggestHandlers = {
  [C in keyof SuggestIpcContract]: (
    req: SuggestIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => SuggestIpcContract[C]['res'] | Promise<SuggestIpcContract[C]['res']>;
};

function wrap<A extends unknown[], R>(fn: (...a: A) => R | Promise<R>): (...a: A) => Promise<R> {
  return async (...a) => {
    try {
      return await fn(...a);
    } catch (e) {
      throw toPatchError(e);
    }
  };
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Invalid ${name}`);
  return v;
};

/** Code Suggest IPC (spec 14 §6.4). */
export function createSuggestHandlers(svc: SuggestService): SuggestHandlers {
  return {
    'suggest:start': wrap(({ repoId, pr }) => svc.start(repoId, pr)),
    'suggest:sessions': wrap(() => svc.sessions()),
    'suggest:changes': wrap(({ sessionId }) => svc.changes(str(sessionId, 'session'))),
    'suggest:submit': wrap((req) => svc.submit(req)),
    'suggest:discard': wrap(({ sessionId }) => svc.discard(str(sessionId, 'session'))),
    'suggest:list': wrap(({ repoId, pr }) => svc.list(repoId, pr)),
    'suggest:open': wrap((req) => svc.open(req)),
    'suggest:apply': wrap((req) => svc.apply(req)),
    'suggest:setStatus': wrap(({ id, status }) => {
      if (!['open', 'applied', 'dismissed'].includes(status)) throw new Error('Invalid status');
      return svc.setStatus(str(id, 'suggestion'), status);
    }),
  };
}
