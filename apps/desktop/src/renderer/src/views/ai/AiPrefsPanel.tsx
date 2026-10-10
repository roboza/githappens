import { CheckCircle2, KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  AI_DEFAULT_ENDPOINTS,
  AI_DEFAULT_MODELS,
  AI_EFFORTS,
  AI_FEATURE_GROUP_INFO,
  AI_FEATURE_GROUPS,
  AI_MODEL_SUGGESTIONS,
  AI_PROVIDER_LABELS,
  type AiEffort,
  type AiError,
  type AiFeatureGroup,
  type AiKeyStatus,
  type AiProviderId,
} from '../../../../shared/ipc/ai-contract';
import { aiInvoke, describeAiError } from '../../ai/api';
import { useSetting, useSettingsStore } from '../../stores/settings';
import s from './Ai.module.css';

const PROVIDERS = Object.keys(AI_PROVIDER_LABELS) as AiProviderId[];
const NEEDS_URL: AiProviderId[] = ['azure-openai', 'openai-compatible'];

/**
 * Preferences → AI (spec 12 §4.5): provider, model, endpoint, effort and the API key. The key goes to the
 * main-process SecretStore and is never read back: the panel only shows "••••abcd". Other `ai.*` settings
 * (style, language, instructions, limits) are regular registry settings.
 */
export function AiPrefsPanel() {
  const set = useSettingsStore((st) => st.set);
  const enabled = useSetting('ai.enabled') ?? false;
  const provider = useSetting('ai.provider') ?? 'anthropic';
  const model = useSetting('ai.model') ?? '';
  const baseUrl = useSetting('ai.baseUrl') ?? '';
  const effort = useSetting('ai.effort') ?? 'auto';

  const [keys, setKeys] = useState<Partial<Record<AiProviderId, AiKeyStatus>>>({});
  const key = keys[provider] ?? null;
  const setKey = (k: AiKeyStatus): void => setKeys((m) => ({ ...m, [provider]: k }));
  const [keyInput, setKeyInput] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  type TestResult = { ok: boolean; latencyMs: number; error?: AiError } | 'running';
  const [testState, setTest] = useState<{ provider: AiProviderId; result: TestResult } | null>(null);
  const test = testState?.provider === provider ? testState.result : null;
  // drafts are only set while the user is typing; null = show the stored setting
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const modelValue = modelDraft ?? model;
  const urlValue = urlDraft ?? baseUrl;

  useEffect(() => {
    if (keys[provider]) return;
    let live = true;
    aiInvoke('ai:key:status', { provider })
      .then((k) => live && setKeys((m) => ({ ...m, [provider]: k })))
      .catch(() => live && setKeys((m) => ({ ...m, [provider]: { hasKey: false } })));
    return () => {
      live = false;
    };
  }, [provider, keys]);

  const saveKey = async (): Promise<void> => {
    setKeyError(null);
    try {
      setKey(await aiInvoke('ai:key:set', { provider, key: keyInput }));
      setKeyInput('');
      setTest(null);
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : String(e));
    }
  };
  const clearKey = async (): Promise<void> => {
    setKey(await aiInvoke('ai:key:clear', { provider }));
    setTest(null);
  };
  const runTest = async (): Promise<void> => {
    const p = provider;
    setTest({ provider: p, result: 'running' });
    try {
      const result = await aiInvoke('ai:testConnection', {
        provider: p,
        model: modelValue,
        baseUrl: urlValue,
      });
      setTest({ provider: p, result });
    } catch (e) {
      setTest({
        provider: p,
        result: {
          ok: false,
          latencyMs: 0,
          error: { code: 'provider', message: e instanceof Error ? e.message : String(e) },
        },
      });
    }
  };

  const keyOptional = provider === 'openai-compatible';
  const defaultModel = AI_DEFAULT_MODELS[provider];

  return (
    <div className={s.prefs}>
      <label className={s.row}>
        <input type="checkbox" checked={enabled} onChange={(e) => void set('ai.enabled', e.target.checked)} />
        Enable AI features
      </label>
      <p className={s.note}>
        Bring your own key: requests go directly from this computer to the provider. When off, every AI button
        is hidden.
      </p>

      <label className={s.field}>
        Provider
        <select value={provider} onChange={(e) => void set('ai.provider', e.target.value as AiProviderId)}>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {AI_PROVIDER_LABELS[p]}
              {p === 'anthropic' ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </label>

      <label className={s.field}>
        {provider === 'azure-openai' ? 'Deployment / model' : 'Model'}
        <input
          className={s.input}
          list="kl-ai-models"
          value={modelValue}
          placeholder={defaultModel || 'model id'}
          onChange={(e) => setModelDraft(e.target.value)}
          onBlur={() => {
            if (modelDraft !== null && modelDraft !== model) void set('ai.model', modelDraft.trim());
            setModelDraft(null);
          }}
        />
        <datalist id="kl-ai-models">
          {AI_MODEL_SUGGESTIONS[provider].map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {defaultModel && <span className={s.note}>Leave empty for the default ({defaultModel}).</span>}
      </label>

      <label className={s.field}>
        Endpoint URL{NEEDS_URL.includes(provider) ? '' : ' (optional)'}
        <input
          className={s.input}
          value={urlValue}
          placeholder={
            AI_DEFAULT_ENDPOINTS[provider] ||
            (provider === 'azure-openai'
              ? 'https://<resource>.openai.azure.com/openai/deployments/<deployment>'
              : '')
          }
          onChange={(e) => setUrlDraft(e.target.value)}
          onBlur={() => {
            if (urlDraft !== null && urlDraft !== baseUrl) void set('ai.baseUrl', urlDraft.trim());
            setUrlDraft(null);
          }}
        />
        {provider === 'openai-compatible' && (
          <span className={s.note}>
            Ollama, LM Studio and similar. Small local models may produce unusable output.
          </span>
        )}
      </label>

      <label className={s.field}>
        Effort
        <select value={effort} onChange={(e) => void set('ai.effort', e.target.value as typeof effort)}>
          <option value="auto">
            Auto (low for messages, medium for explanations, high for conflicts/composing)
          </option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </label>

      <PerFeatureSettings />

      <div className={s.field}>
        <span>
          <KeyRound size={12} /> API key{keyOptional ? ' (optional for local servers)' : ''}
        </span>
        {key?.hasKey ? (
          <div className={s.keyRow}>
            <code>••••{key.last4}</code>
            <span className={s.note}>stored encrypted on this computer</span>
            <button type="button" onClick={() => void clearKey()}>
              Remove
            </button>
          </div>
        ) : null}
        <form
          className={s.keyRow}
          onSubmit={(e) => {
            e.preventDefault();
            if (keyInput.trim()) void saveKey();
          }}
        >
          <input
            className={s.input}
            type="password"
            autoComplete="off"
            aria-label={`${AI_PROVIDER_LABELS[provider]} API key`}
            placeholder={key?.hasKey ? 'Replace key…' : 'Paste your API key'}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <button type="submit" disabled={!keyInput.trim()}>
            Save key
          </button>
        </form>
        {keyError && (
          <p className={s.error} role="alert">
            {keyError}
          </p>
        )}
      </div>

      <div className={s.row}>
        <button type="button" disabled={test === 'running'} onClick={() => void runTest()}>
          {test === 'running' ? 'Testing…' : 'Test connection'}
        </button>
        {test && test !== 'running' && test.ok && (
          <span className={s.ok}>
            <CheckCircle2 size={12} /> Connected ({test.latencyMs} ms)
          </span>
        )}
        {test && test !== 'running' && !test.ok && (
          <span className={s.error} role="alert">
            {describeAiError(test.error)}
          </span>
        )}
      </div>
    </div>
  );
}

const cap = (e: AiEffort): string => e[0]!.toUpperCase() + e.slice(1);

/**
 * Per-feature effort and custom instructions (spec 12 §2.2 / §4.5). An unset effort follows the global
 * Effort setting (or the feature default under Auto); instructions are added after the global ones and
 * before `.githappens/ai-instructions.md`.
 */
function PerFeatureSettings() {
  const set = useSettingsStore((st) => st.set);
  const globalEffort = useSetting('ai.effort') ?? 'auto';
  const overrides = useSetting('ai.effortOverrides') ?? {};
  const instructions = useSetting('ai.featureInstructions') ?? {};
  const [drafts, setDrafts] = useState<Partial<Record<AiFeatureGroup, string>>>({});
  const [error, setError] = useState<string | null>(null);

  const save = async (patch: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await patch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const setEffort = (g: AiFeatureGroup, v: string): void => {
    const next = { ...overrides };
    if (v === '') delete next[g];
    else next[g] = v as AiEffort;
    void save(() => set('ai.effortOverrides', next));
  };
  const commitInstructions = (g: AiFeatureGroup): void => {
    const draft = drafts[g];
    setDrafts((d) => {
      const n = { ...d };
      delete n[g];
      return n;
    });
    if (draft === undefined || draft === (instructions[g] ?? '')) return;
    const next = { ...instructions };
    if (draft.trim()) next[g] = draft;
    else delete next[g];
    void save(() => set('ai.featureInstructions', next));
  };
  const customized = AI_FEATURE_GROUPS.filter((g) => overrides[g] || instructions[g]?.trim()).length;

  return (
    <details className={s.field}>
      <summary>Per-feature settings{customized ? ` (${customized} customized)` : ''}</summary>
      <p className={s.note}>
        Effort and extra instructions for each feature. Instructions are added after the global custom
        instructions and before the repository&apos;s .githappens/ai-instructions.md.
      </p>
      {AI_FEATURE_GROUPS.map((g) => {
        const info = AI_FEATURE_GROUP_INFO[g];
        const inherited = globalEffort === 'auto' ? info.defaultEffort : globalEffort;
        const value = drafts[g] ?? instructions[g] ?? '';
        return (
          <fieldset key={g} className={s.field}>
            <legend>{info.label}</legend>
            <label className={s.row}>
              Effort
              <select value={overrides[g] ?? ''} onChange={(e) => setEffort(g, e.target.value)}>
                <option value="">
                  Default ({cap(inherited)}
                  {globalEffort === 'auto' ? '' : ', from Effort'})
                </option>
                {AI_EFFORTS.map((e) => (
                  <option key={e} value={e}>
                    {cap(e)}
                  </option>
                ))}
              </select>
            </label>
            <label className={s.field}>
              Instructions
              <textarea
                className={s.textarea}
                rows={value.includes('\n') ? 4 : 2}
                maxLength={8000}
                placeholder="e.g. Reference the issue key from the branch name"
                value={value}
                onChange={(e) => setDrafts((d) => ({ ...d, [g]: e.target.value }))}
                onBlur={() => commitInstructions(g)}
              />
            </label>
          </fieldset>
        );
      })}
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
