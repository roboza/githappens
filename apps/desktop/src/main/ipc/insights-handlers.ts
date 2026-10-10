import type { InsightsIpcContract, InsightsQuery } from '../../shared/ipc/insights-contract';
import type { InsightsService } from '../cloud/insights';
import type { HandlerContext } from './registry';

export type InsightsHandlers = {
  [C in keyof InsightsIpcContract]: (
    req: InsightsIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => InsightsIpcContract[C]['res'] | Promise<InsightsIpcContract[C]['res']>;
};

const RANGES = new Set(['7d', '30d', '90d']);

/** Insights IPC (spec 14 §6.6). */
export function createInsightsHandlers(svc: InsightsService): InsightsHandlers {
  return {
    'insights:compute': (q: InsightsQuery) => {
      if (typeof q?.workspaceId !== 'string' || !RANGES.has(q.range))
        throw new Error('Invalid insights query');
      return svc.compute(q);
    },
    'insights:clearCache': ({ workspaceId }) => svc.clearCache(workspaceId),
  };
}
