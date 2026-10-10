import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { invalidateCoalesced, refreshScopes } from '../src/renderer/src/repo/queries';

/**
 * spec 02 §6.14 "Coalescing with reads": if a status refresh is in flight and another is requested, mark it
 * dirty and re-run once after completion. Never stack.
 */
describe('refresh coalescing', () => {
  it('never stacks: requests during an in-flight status read cause exactly one re-run afterwards', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: (() => void)[] = [];
    const observer = new QueryObserver(qc, {
      queryKey: ['status', 'r1'],
      queryFn: async () => {
        calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((r) => releases.push(r));
        inFlight--;
        return calls;
      },
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1); // initial read in flight

    // three watcher refreshes arrive while it is still running
    refreshScopes(qc, 'r1', ['status']);
    refreshScopes(qc, 'r1', ['status']);
    invalidateCoalesced(qc, ['status', 'r1']);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);

    releases.shift()!();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2); // one coalesced re-run
    releases.shift()!();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2);
    expect(maxInFlight).toBe(1);
    expect(observer.getCurrentResult().data).toBe(2);

    // idle: a refresh runs right away
    refreshScopes(qc, 'r1', ['status']);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(3);
    releases.shift()!();
    unsubscribe();
    qc.clear();
  });
});
