import type { LogPage } from '@githappens/git/types';

/** Paging helpers of `useHistory` (pure, unit-tested without a renderer). */

/** Appends in place (no `[...a, ...b]` copy per page, which made loading everything quadratic). */
export function appendInPlace<T>(target: T[], items: readonly T[]): void {
  for (let i = 0; i < items.length; i++) target.push(items[i]!);
}

type Page = Pick<LogPage, 'commits' | 'cursor' | 'done'>;

/**
 * Fetches pages while `want()` asks for more (it returns the most commits still wanted, 0 to stop).
 * Pipelined: the next request is sent as soon as a page arrives, so git and the main process prepare
 * page k+1 while the renderer lays out page k. Consecutive pages grow from `firstSize` up to `maxSize`
 * (fewer round trips and renders). Every requested page is handed to `onPage` in order, so the cursor
 * never runs ahead of the loaded rows. Stops silently when `isCurrent()` turns false (restarted).
 */
export async function streamPages(o: {
  next(pageSize: number): Promise<Page>;
  isCurrent(): boolean;
  onPage(page: Page): void;
  want(): number;
  firstSize: number;
  maxSize?: number;
}): Promise<void> {
  const maxSize = o.maxSize ?? o.firstSize;
  let size = Math.max(1, o.firstSize);
  let next = o.next(size);
  for (;;) {
    const page = await next;
    if (!o.isCurrent()) return;
    o.onPage(page);
    const wanted = page.done || !page.cursor ? 0 : o.want();
    if (wanted <= 0) return;
    size = Math.max(1, Math.min(maxSize, size * 2, wanted));
    next = o.next(size);
  }
}
