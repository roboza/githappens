import type { AiIpcContract, AiProviderId } from '../../shared/ipc/ai-contract';
import type { AiService } from '../ai/ai-service';
import type { HandlerContext } from './registry';

export type AiHandlers = {
  [C in keyof AiIpcContract]: (
    req: AiIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => AiIpcContract[C]['res'] | Promise<AiIpcContract[C]['res']>;
};

const PROVIDERS: readonly AiProviderId[] = [
  'anthropic',
  'openai',
  'azure-openai',
  'gemini',
  'openai-compatible',
];

function provider(v: unknown): AiProviderId {
  if (!PROVIDERS.includes(v as AiProviderId)) throw new Error('Unknown AI provider');
  return v as AiProviderId;
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`Invalid ${name}`);
  return v;
}

/**
 * AI IPC (spec 12 §5). Keys only flow renderer → main (`ai:key:set`); every reply carries at most
 * `{ hasKey, last4 }`. Stream events go to the requesting window (`senderId`).
 */
export function createAiHandlers(svc: AiService): AiHandlers {
  return {
    'ai:run': (req, ctx) => {
      str(req?.requestId, 'requestId');
      str(req?.repoId, 'repoId');
      return svc.run(req, ctx.senderId);
    },
    'ai:cancel': ({ requestId }) => svc.cancel(str(requestId, 'requestId')),
    'ai:status': ({ repoId }) => svc.status(repoId),
    'ai:testConnection': (req) =>
      svc.testConnection({
        provider: req.provider === undefined ? undefined : provider(req.provider),
        model: req.model,
        baseUrl: req.baseUrl,
      }),
    'ai:key:set': ({ provider: p, key }) => svc.setKey(provider(p), str(key, 'key')),
    'ai:key:clear': ({ provider: p }) => svc.clearKey(provider(p)),
    'ai:key:status': ({ provider: p }) => svc.keyStatus(p === undefined ? undefined : provider(p)),
    'ai:changelog:save': ({ repoId, markdown }) =>
      svc.saveChangelog(str(repoId, 'repoId'), str(markdown, 'markdown')),
  };
}
