import type { IpcResult } from '@githappens/git/types';

import type {
  TerminalEventContract,
  TerminalId,
  TerminalIpcContract,
} from '../../../../shared/ipc/terminal-contract';
import { IpcError } from '../../lib/api';

/**
 * Typed access to the terminal channels of `window.api`. Kept local (instead of the
 * generic `invoke`) so this view only depends on the terminal contract.
 */
type TerminalChannel = keyof TerminalIpcContract;
type TerminalEvent = keyof TerminalEventContract;

interface TerminalBridge {
  invoke<C extends TerminalChannel>(
    channel: C,
    req: TerminalIpcContract[C]['req'],
  ): Promise<IpcResult<TerminalIpcContract[C]['res']>>;
  on<E extends TerminalEvent>(event: E, cb: (payload: TerminalEventContract[E]) => void): () => void;
}

const bridge = (): TerminalBridge => window.api as unknown as TerminalBridge;

export async function terminalInvoke<C extends TerminalChannel>(
  channel: C,
  req: TerminalIpcContract[C]['req'],
): Promise<TerminalIpcContract[C]['res']> {
  const r = await bridge().invoke(channel, req);
  if (r.ok) return r.data;
  throw new IpcError(r.error);
}

// ---- single event subscription, demultiplexed by terminal id ----

export interface TerminalSink {
  data(data: string): void;
  exit(exitCode: number, signal?: number): void;
}

type Pending = { data: string[]; exit?: { exitCode: number; signal?: number } };

const sinks = new Map<TerminalId, TerminalSink>();
/** Events that arrive before their sink registers (create reply racing the first output). */
const pending = new Map<TerminalId, Pending>();
let subscribed = false;

function pend(id: TerminalId): Pending {
  let p = pending.get(id);
  if (!p) {
    p = { data: [] };
    pending.set(id, p);
    setTimeout(() => pending.delete(id), 5000);
  }
  return p;
}

/** Subscribes to terminal events once; call before `terminal:create` so no output is missed. */
export function ensureTerminalEvents(): void {
  if (subscribed) return;
  subscribed = true;
  bridge().on('terminal:data', ({ id, data }) => {
    const s = sinks.get(id);
    if (s) s.data(data);
    else pend(id).data.push(data);
  });
  bridge().on('terminal:exit', ({ id, exitCode, signal }) => {
    const s = sinks.get(id);
    if (s) s.exit(exitCode, signal);
    else pend(id).exit = { exitCode, signal };
  });
}

export function attachTerminalSink(id: TerminalId, sink: TerminalSink): () => void {
  ensureTerminalEvents();
  sinks.set(id, sink);
  const p = pending.get(id);
  if (p) {
    pending.delete(id);
    for (const d of p.data) sink.data(d);
    if (p.exit) sink.exit(p.exit.exitCode, p.exit.signal);
  }
  return () => {
    if (sinks.get(id) === sink) sinks.delete(id);
  };
}
