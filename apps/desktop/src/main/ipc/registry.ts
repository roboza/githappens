import { GitError, makeError, type IpcResult } from '@githappens/git';

import {
  INVOKE_CHANNELS,
  type EventChannel,
  type EventContract,
  type InvokeChannel,
  type Req,
  type Res,
} from '../../shared/ipc/contract';

export interface HandlerContext {
  senderId: number;
}

/** Every channel must have a handler — enforced at compile time by this mapped type. */
export type IpcHandlers = {
  [C in InvokeChannel]: (req: Req<C>, ctx: HandlerContext) => Res<C> | Promise<Res<C>>;
};

/** Minimal subset of Electron's ipcMain used here (keeps this module testable). */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (
      event: { sender: { id: number }; senderFrame?: { url: string } | null },
      req: unknown,
    ) => unknown,
  ): void;
}

export function toIpcError(e: unknown, channel: string): IpcResult<never> {
  if (e instanceof GitError) return { ok: false, error: e.serialized };
  const message = e instanceof Error ? e.message : String(e);
  return { ok: false, error: makeError('Unknown', { argv: [] }, message, { channel }) };
}

/**
 * Registers all handlers. Each reply is an `IpcResult`; exceptions never cross IPC as
 * rejections. `isTrustedSender` rejects calls from frames that are not our app UI.
 */
export function registerIpcHandlers(
  ipcMain: IpcMainLike,
  handlers: IpcHandlers,
  isTrustedSender: (url: string | undefined) => boolean = () => true,
): InvokeChannel[] {
  for (const channel of INVOKE_CHANNELS) {
    const handler = handlers[channel] as (req: unknown, ctx: HandlerContext) => unknown;
    ipcMain.handle(channel, async (event, req) => {
      if (!isTrustedSender(event.senderFrame?.url)) {
        return toIpcError(new Error('Untrusted IPC sender'), channel);
      }
      try {
        const data = await handler(req ?? {}, { senderId: event.sender.id });
        return { ok: true, data } satisfies IpcResult<unknown>;
      } catch (e) {
        return toIpcError(e, channel);
      }
    });
  }
  return [...INVOKE_CHANNELS];
}

export interface WebContentsLike {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

/** Typed broadcast to all renderer windows. */
export function createBroadcaster(targets: () => WebContentsLike[]) {
  return <E extends EventChannel>(event: E, payload: EventContract[E]): void => {
    for (const wc of targets()) if (!wc.isDestroyed()) wc.send(event, payload);
  };
}
