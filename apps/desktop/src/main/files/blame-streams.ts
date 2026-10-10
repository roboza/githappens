import { randomUUID } from 'node:crypto';

import { blameIncremental, type BlameChunk, type GitService } from '@githappens/git';

import type { BlameStreamOpts, FilesEventContract } from '../../shared/ipc/files-contract';

type Emit = <E extends keyof FilesEventContract>(event: E, payload: FilesEventContract[E]) => void;

/**
 * Streaming blame sessions (spec 07 §6.8): `blame:start` returns an id at once; chunks are broadcast as
 * `blame:chunk` and the end as `blame:done`. `cancel` (or a new start for the same sender) kills git.
 */
export class BlameStreams {
  private readonly live = new Map<string, AbortController>();

  constructor(
    private readonly emit: Emit,
    private readonly run: typeof blameIncremental = blameIncremental,
  ) {}

  start(svc: GitService, path: string, rev: string | undefined, opts: BlameStreamOpts = {}): string {
    const streamId = randomUUID();
    const controller = new AbortController();
    this.live.set(streamId, controller);
    const onChunk = (c: BlameChunk): void => {
      if (!controller.signal.aborted) this.emit('blame:chunk', { streamId, ...c });
    };
    // let the renderer subscribe before the first chunk arrives
    setTimeout(() => {
      this.run(
        svc,
        path,
        rev,
        {
          ignoreWhitespace: !!opts.ignoreWhitespace,
          detectMoves: !!opts.detectMoves,
          detectCopies: !!opts.detectCopies,
          signal: controller.signal,
        },
        onChunk,
      ).then(
        () => this.finish(streamId),
        (e: unknown) => this.finish(streamId, e),
      );
    }, 0);
    return streamId;
  }

  cancel(streamId: string): void {
    this.live.get(streamId)?.abort();
    this.live.delete(streamId);
  }

  cancelAll(): void {
    for (const id of [...this.live.keys()]) this.cancel(id);
  }

  get size(): number {
    return this.live.size;
  }

  private finish(streamId: string, e?: unknown): void {
    const controller = this.live.get(streamId);
    this.live.delete(streamId);
    if (!controller || controller.signal.aborted) return;
    const error = e === undefined ? undefined : e instanceof Error ? e.message : String(e);
    this.emit('blame:done', { streamId, ...(error ? { error } : {}) });
  }
}
