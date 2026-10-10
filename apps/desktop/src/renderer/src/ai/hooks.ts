import type { RepoId } from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';
import { createElement, useCallback, useEffect, useRef, useState } from 'react';

import type {
  AiError,
  AiFeature,
  AiFeatureResults,
  AiRequest,
  AiStatus,
  AiStreamEvent,
} from '../../../shared/ipc/ai-contract';
import { useSetting, useSettingsStore } from '../stores/settings';
import { ConsentDialog } from '../views/ai/ConsentDialog';
import { aiInvoke, aiOn, newRequestId } from './api';
import { mountDialog } from './mount';

/** Master switch (spec 12 §4.4): false until settings load, so AI UI never flashes in. */
export function useAiEnabled(): boolean {
  return useSetting('ai.enabled') === true;
}

/** Same, for non-React code (menus as data). */
export function aiEnabled(): boolean {
  return useSettingsStore.getState().values?.['ai.enabled'] === true;
}

export const aiStatusKey = (repoId?: RepoId) => ['ai', 'status', repoId ?? ''] as const;

/** `ai:status`; refetched whenever a relevant `ai.*` setting changes. */
export function useAiStatus(repoId?: RepoId) {
  const enabled = useAiEnabled();
  const provider = useSetting('ai.provider');
  const model = useSetting('ai.model');
  const baseUrl = useSetting('ai.baseUrl');
  const consent = useSetting('ai.consent');
  return useQuery({
    queryKey: [...aiStatusKey(repoId), provider, model, baseUrl, consent, enabled],
    queryFn: () => aiInvoke('ai:status', { repoId }),
    enabled,
    staleTime: 30_000,
  });
}

let consentInFlight: Promise<boolean> | null = null;

/** Show the consent dialog when needed; resolves true when requests may be sent. */
export async function ensureConsent(): Promise<boolean> {
  const status: AiStatus = await aiInvoke('ai:status', {});
  if (!status.needsConsent) return true;
  consentInFlight ??= mountDialog<boolean>((done) =>
    createElement(ConsentDialog, { status, onDone: done }),
  ).then(async (ok) => {
    if (ok) await useSettingsStore.getState().set('ai.consent', status.consentKey);
    return ok;
  });
  try {
    return await consentInFlight;
  } finally {
    consentInFlight = null;
  }
}

type FeatureRequest<F extends AiFeature> = Omit<Extract<AiRequest, { feature: F }>, 'requestId' | 'feature'>;

export interface AiRunState<F extends AiFeature> {
  status: 'idle' | 'running' | 'done' | 'error';
  /** Streamed text so far (markdown features). */
  text: string;
  /** Best-effort partial structured result while streaming. */
  partial?: unknown;
  result?: AiFeatureResults[F];
  error?: AiError;
  truncated?: boolean;
  omitted?: string[];
}

export interface AiRunHandlers {
  onPartial?(partial: unknown): void;
  onReset?(): void;
}

const IDLE = { status: 'idle', text: '' } as const;

/**
 * Run one AI feature with streaming (`ai:event`). Starting again cancels the previous request; the
 * request is cancelled on unmount (e.g. switching repos). Resolves with the result, or null on
 * error/cancel/no consent (the error is in `state.error`).
 */
export function useAiRun<F extends AiFeature>(feature: F) {
  const [state, setState] = useState<AiRunState<F>>(IDLE);
  const current = useRef<{ id: string; off: () => void; settle: () => void } | null>(null);

  const stop = useCallback((cancel: boolean) => {
    const c = current.current;
    if (!c) return;
    current.current = null;
    c.off();
    if (cancel) c.settle();
    if (cancel) void aiInvoke('ai:cancel', { requestId: c.id }).catch(() => undefined);
  }, []);

  useEffect(() => () => stop(true), [stop]);

  const start = useCallback(
    async (req: FeatureRequest<F>, h: AiRunHandlers = {}): Promise<AiFeatureResults[F] | null> => {
      stop(true);
      setState({ status: 'running', text: '' });
      if (!(await ensureConsent().catch(() => false))) {
        setState(IDLE);
        return null;
      }
      const requestId = newRequestId();
      return new Promise((resolve) => {
        let text = '';
        const off = aiOn('ai:event', (e: AiStreamEvent) => {
          if (e.requestId !== requestId) return;
          if (e.kind === 'delta') {
            if (e.reset) {
              text = '';
              h.onReset?.();
            }
            if (e.text) text += e.text;
            if (e.partial !== undefined) h.onPartial?.(e.partial);
            setState((st) => ({
              ...st,
              status: 'running',
              text,
              partial: e.partial ?? (e.reset ? undefined : st.partial),
            }));
            return;
          }
          stop(false);
          if (e.kind === 'done') {
            const result = e.result as AiFeatureResults[F];
            setState({ status: 'done', text, result, truncated: e.truncated, omitted: e.omitted });
            resolve(result);
          } else {
            const error = e.error ?? { code: 'provider', message: 'Unknown error' };
            setState({ status: error.code === 'cancelled' ? 'idle' : 'error', text, error });
            resolve(null);
          }
        });
        current.current = { id: requestId, off, settle: () => resolve(null) };
        aiInvoke('ai:run', { ...req, feature, requestId } as AiRequest).catch((err: unknown) => {
          stop(false);
          const error: AiError = {
            code: 'provider',
            message: err instanceof Error ? err.message : String(err),
          };
          setState({ status: 'error', text: '', error });
          resolve(null);
        });
      });
    },
    [feature, stop],
  );

  const cancel = useCallback(() => {
    stop(true);
    setState(IDLE);
  }, [stop]);

  const reset = useCallback(() => setState(IDLE), []);

  return { state, start, cancel, reset, running: state.status === 'running' };
}
