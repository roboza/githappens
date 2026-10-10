import fs from 'node:fs';
import path from 'node:path';

import type { GitService, RepoId } from '@githappens/git';
import { z } from 'zod';

import {
  AI_DEFAULT_ENDPOINTS,
  AI_DEFAULT_MODELS,
  type AiEffort,
  type AiError,
  type AiFeature,
  type AiKeyStatus,
  type AiProviderId,
  type AiRequest,
  type AiStatus,
  type AiStreamEvent,
  type AiUsage,
} from '../../shared/ipc/ai-contract';
import type { SettingValue } from '../../shared/settings/registry';
import { secretAccount, type SecretStore } from '../secrets/secret-store';
import { ContextBuilder, readRepoInstructions, repoAiDisabled, type BuiltContext } from './context-builder';
import {
  CommitMessageSchema,
  ComposeSchema,
  ConflictSchema,
  InvalidOutputError,
  parseWith,
  partialStringField,
  postCommitMessage,
  postCompose,
  postConflicts,
  postPrDraft,
  PrDraftSchema,
} from './parsers';
import { featureInstructions, resolveEffort } from './feature-settings';
import { repairPrompt, systemPrompt, userPrompt, type PromptSettings } from './prompts';
import {
  AiProviderError,
  createProviderFactory,
  type AiProvider,
  type OutputSchema,
  type ProviderFactory,
} from './providers';

export type AiSettingKey =
  | 'ai.enabled'
  | 'ai.provider'
  | 'ai.model'
  | 'ai.baseUrl'
  | 'ai.effort'
  | 'ai.commitStyle'
  | 'ai.language'
  | 'ai.instructions'
  | 'ai.effortOverrides'
  | 'ai.featureInstructions'
  | 'ai.maxDiffChars'
  | 'ai.excludeGlobs'
  | 'ai.consent';

/** Everything AiService needs from the app (spec 12 §6.3); injected so it is testable without Electron. */
export interface AiServiceDeps {
  /** Read an `ai.*` setting of the active profile (SettingsStore.get). */
  settings: <K extends AiSettingKey>(key: K) => SettingValue<K>;
  /** Main-process SecretStore; keys live under `secretAccount(profileId, 'ai', provider)`. */
  secrets: Pick<SecretStore, 'get' | 'set' | 'delete' | 'available'>;
  /** Active profile id. */
  profileId: () => string;
  /** Read-only GitService of an open repo (RepoManager.get); throws for unknown repos. */
  git: (repoId: RepoId) => GitService;
  /** Deliver a stream event to the renderer that started the request (`ai:event`). */
  emit: (event: AiStreamEvent, senderId?: number) => void;
  /** Provider construction (tests inject fakes); defaults to the real Anthropic SDK / fetch providers. */
  clientFactory?: ProviderFactory;
  /** Max concurrent requests per window (spec: 2). */
  concurrency?: number;
  now?: () => number;
}

interface FeatureSpec {
  maxTokens: number;
  schema?: OutputSchema;
  /** Markdown features stream text deltas; JSON features stream partial fields. */
  output: 'markdown' | 'json';
}

const schema = (name: string, zod: z.ZodType): OutputSchema => ({
  name,
  zod,
  json: z.toJSONSchema(zod, { target: 'draft-7' }) as Record<string, unknown>,
});
const COMMIT = schema('commit_message', CommitMessageSchema);
const FEATURES: Record<AiFeature, FeatureSpec> = {
  commitMessage: { maxTokens: 2000, schema: COMMIT, output: 'json' },
  stashMessage: { maxTokens: 2000, schema: COMMIT, output: 'json' },
  explainCommits: { maxTokens: 4000, output: 'markdown' },
  explainBranch: { maxTokens: 4000, output: 'markdown' },
  explainWip: { maxTokens: 4000, output: 'markdown' },
  prDraft: { maxTokens: 4000, schema: schema('pr_draft', PrDraftSchema), output: 'json' },
  changelog: { maxTokens: 8000, output: 'markdown' },
  conflictResolve: {
    maxTokens: 16000,
    schema: schema('conflict_proposals', ConflictSchema),
    output: 'json',
  },
  composeCommits: {
    maxTokens: 16000,
    schema: schema('commit_plan', ComposeSchema),
    output: 'json',
  },
};

export function featureSpec(f: AiFeature): Readonly<FeatureSpec> {
  return FEATURES[f];
}

/** Providers that work without a key (local servers). */
const KEY_OPTIONAL: AiProviderId[] = ['openai-compatible'];

interface Job {
  req: AiRequest;
  senderId: number;
  controller: AbortController;
  started: boolean;
}

/**
 * AIService (spec 12 §6.3): validates state (enabled, consent, key, repo switch), builds the context,
 * calls the provider with streaming, parses/validates output and streams `ai:event`s. RequestManager
 * semantics: one AbortController per request and at most `concurrency` running requests per window.
 */
export class AiService {
  private readonly jobs = new Map<string, Job>();
  private readonly factory: ProviderFactory;
  private readonly concurrency: number;

  constructor(private readonly d: AiServiceDeps) {
    this.factory = d.clientFactory ?? createProviderFactory();
    this.concurrency = d.concurrency ?? 2;
  }

  // ---- configuration ----

  private provider(): AiProviderId {
    return this.d.settings('ai.provider');
  }

  model(provider = this.provider()): string {
    return this.d.settings('ai.model').trim() || AI_DEFAULT_MODELS[provider];
  }

  endpoint(provider = this.provider()): string {
    return this.d.settings('ai.baseUrl').trim() || AI_DEFAULT_ENDPOINTS[provider];
  }

  consentKey(provider = this.provider()): string {
    return `${provider}|${this.endpoint(provider)}`;
  }

  private account(provider: AiProviderId): string {
    return secretAccount(this.d.profileId(), 'ai', provider);
  }

  private key(provider: AiProviderId): string | null {
    if (!this.d.secrets.available) return null;
    return this.d.secrets.get(this.account(provider));
  }

  keyStatus(provider = this.provider()): AiKeyStatus {
    const k = this.key(provider);
    return k ? { hasKey: true, last4: k.slice(-4) } : { hasKey: false };
  }

  setKey(provider: AiProviderId, key: string): AiKeyStatus {
    const k = key.trim();
    if (!k || k.length > 1000 || /[\s\0]/.test(k)) throw new Error('That does not look like an API key.');
    this.d.secrets.set(this.account(provider), k);
    return this.keyStatus(provider);
  }

  clearKey(provider: AiProviderId): AiKeyStatus {
    this.d.secrets.delete(this.account(provider));
    return { hasKey: false };
  }

  async status(repoId?: RepoId): Promise<AiStatus> {
    const provider = this.provider();
    const s: AiStatus = {
      enabled: this.d.settings('ai.enabled'),
      configured: KEY_OPTIONAL.includes(provider) || this.keyStatus(provider).hasKey,
      provider,
      model: this.model(provider),
      endpoint: this.endpoint(provider),
      consentKey: this.consentKey(provider),
      needsConsent: this.d.settings('ai.consent') !== this.consentKey(provider),
    };
    if (repoId) {
      try {
        s.repoDisabled = await repoAiDisabled(this.d.git(repoId));
      } catch {
        /* repo not open */
      }
    }
    return s;
  }

  async testConnection(req: {
    provider?: AiProviderId;
    model?: string;
    baseUrl?: string;
  }): Promise<{ ok: boolean; latencyMs: number; error?: AiError }> {
    const provider = req.provider ?? this.provider();
    const now = this.d.now ?? Date.now;
    const t0 = now();
    try {
      const key = this.key(provider);
      if (!key && !KEY_OPTIONAL.includes(provider))
        throw new AiProviderError('no-key', 'Add an API key first.');
      const model = req.model?.trim() || this.model(provider);
      if (!model) throw new AiProviderError('provider', 'Set a model (or deployment name) first.');
      const p = this.factory({
        provider,
        apiKey: key,
        baseUrl: req.baseUrl ?? (provider === this.provider() ? this.d.settings('ai.baseUrl') : undefined),
      });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      try {
        await p.test(model, ctrl.signal);
      } finally {
        clearTimeout(timer);
      }
      return { ok: true, latencyMs: now() - t0 };
    } catch (e) {
      return { ok: false, latencyMs: now() - t0, error: toAiError(e) };
    }
  }

  // ---- requests ----

  /** Starts a request; results stream as `ai:event`. Never throws for request-level failures. */
  run(req: AiRequest, senderId = 0): { requestId: string } {
    const requestId = req.requestId;
    if (!requestId || this.jobs.has(requestId)) throw new Error('A unique requestId is required.');
    const job: Job = { req, senderId, controller: new AbortController(), started: false };
    this.jobs.set(requestId, job);
    queueMicrotask(() => this.pump(senderId));
    return { requestId };
  }

  cancel(requestId: string): void {
    const job = this.jobs.get(requestId);
    if (!job) return;
    job.controller.abort();
    if (!job.started) {
      this.jobs.delete(requestId);
      this.emitError(job, { code: 'cancelled', message: 'Cancelled.' });
    }
  }

  /** Cancel every request of a window (window closed / reloaded). */
  cancelAll(senderId?: number): void {
    for (const [id, j] of this.jobs) if (senderId === undefined || j.senderId === senderId) this.cancel(id);
  }

  private pump(senderId: number): void {
    const mine = [...this.jobs.values()].filter((j) => j.senderId === senderId);
    let running = mine.filter((j) => j.started).length;
    for (const j of mine) {
      if (running >= this.concurrency) break;
      if (j.started) continue;
      j.started = true;
      running++;
      void this.execute(j).finally(() => {
        this.jobs.delete(j.req.requestId);
        this.pump(senderId);
      });
    }
  }

  private emit(job: Job, e: Omit<AiStreamEvent, 'requestId'>): void {
    this.d.emit({ requestId: job.req.requestId, ...e }, job.senderId);
  }

  private emitError(job: Job, error: AiError): void {
    this.emit(job, { kind: 'error', error });
  }

  /** Prompt settings; instruction order (spec 12 §6.5): global, then the feature's own, then the repo file. */
  private settingsForPrompt(svc: GitService, feature: AiFeature): PromptSettings {
    return {
      commitStyle: this.d.settings('ai.commitStyle'),
      language: this.d.settings('ai.language'),
      instructions: this.d.settings('ai.instructions'),
      featureInstructions: featureInstructions(feature, this.d.settings('ai.featureInstructions')),
      repoInstructions: readRepoInstructions(svc),
    };
  }

  private effort(feature: AiFeature): AiEffort {
    return resolveEffort(feature, this.d.settings('ai.effort'), this.d.settings('ai.effortOverrides'));
  }

  private async execute(job: Job): Promise<void> {
    const { req } = job;
    const signal = job.controller.signal;
    try {
      if (!this.d.settings('ai.enabled'))
        throw new AiProviderError('disabled', 'AI features are turned off.');
      const provider = this.provider();
      if (this.d.settings('ai.consent') !== this.consentKey(provider)) {
        throw new AiProviderError('consent', 'Confirm what is sent to the AI provider first.');
      }
      const key = this.key(provider);
      if (!key && !KEY_OPTIONAL.includes(provider)) {
        throw new AiProviderError('no-key', 'Add an API key in Preferences → AI.');
      }
      const model = this.model(provider);
      if (!model)
        throw new AiProviderError('provider', 'Set a model (or deployment name) in Preferences → AI.');
      const svc = this.d.git(req.repoId);
      if (await repoAiDisabled(svc)) {
        throw new AiProviderError(
          'repo-disabled',
          'AI is disabled for this repository (githappens.ai=false).',
        );
      }
      const ctx = await new ContextBuilder(svc, {
        maxChars: this.d.settings('ai.maxDiffChars'),
        excludeGlobs: this.d.settings('ai.excludeGlobs'),
      }).build(req);
      signal.throwIfAborted();

      const spec = FEATURES[req.feature];
      const system = systemPrompt(req.feature, this.settingsForPrompt(svc, req.feature), {
        changelogFormat: req.feature === 'changelog' ? req.format : undefined,
      });
      const user = userPrompt(ctx.task, ctx.sections, ctx.notes);
      const p = this.factory({ provider, apiKey: key, baseUrl: this.d.settings('ai.baseUrl') });

      const first = await this.call(job, p, { system, user, model, spec, feature: req.feature });
      let usage = first.usage;
      let result: unknown;
      try {
        result = this.parse(req, first.text, ctx);
      } catch (e) {
        if (!(e instanceof InvalidOutputError) || !spec.schema || p.guaranteesSchema) throw e;
        // one repair attempt for providers without server-side schema enforcement
        this.emit(job, { kind: 'delta', reset: true });
        const again = await this.call(job, p, {
          system,
          user: repairPrompt(user, first.text, e.message),
          model,
          spec,
          feature: req.feature,
        });
        usage = addUsage(usage, again.usage);
        result = this.parse(req, again.text, ctx);
      }
      this.emit(job, {
        kind: 'done',
        result,
        ...(usage ? { usage } : {}),
        ...(ctx.truncated ? { truncated: true } : {}),
        ...(ctx.omitted.length ? { omitted: ctx.omitted } : {}),
      });
    } catch (e) {
      this.emitError(job, signal.aborted ? { code: 'cancelled', message: 'Cancelled.' } : toAiError(e));
    }
  }

  private async call(
    job: Job,
    p: AiProvider,
    o: { system: string; user: string; model: string; spec: FeatureSpec; feature: AiFeature },
  ): Promise<{ text: string; usage?: AiUsage }> {
    let acc = '';
    let lastPartial = '';
    const onText = (delta: string): void => {
      acc += delta;
      if (o.spec.output === 'markdown') {
        this.emit(job, { kind: 'delta', text: delta });
        return;
      }
      const partial = partialFor(o.feature, acc);
      if (!partial) return;
      const key = JSON.stringify(partial);
      if (key === lastPartial) return;
      lastPartial = key;
      this.emit(job, { kind: 'delta', partial });
    };
    return p.stream({
      system: o.system,
      user: o.user,
      model: o.model,
      effort: this.effort(o.feature),
      maxTokens: o.spec.maxTokens,
      signal: job.controller.signal,
      schema: o.spec.schema,
      onText,
      onReset: () => {
        acc = '';
        lastPartial = '';
        this.emit(job, { kind: 'delta', reset: true });
      },
    });
  }

  private parse(req: AiRequest, text: string, ctx: BuiltContext): unknown {
    switch (req.feature) {
      case 'commitMessage':
      case 'stashMessage': {
        const r = postCommitMessage(parseWith(CommitMessageSchema, text));
        if (!r.summary) throw new InvalidOutputError('The summary was empty.');
        return req.feature === 'stashMessage' ? { summary: r.summary, description: '' } : r;
      }
      case 'prDraft': {
        const r = postPrDraft(parseWith(PrDraftSchema, text));
        if (!r.title) throw new InvalidOutputError('The title was empty.');
        return r;
      }
      case 'conflictResolve':
        return { proposals: postConflicts(parseWith(ConflictSchema, text).proposals, ctx.conflictIds ?? []) };
      case 'composeCommits': {
        const c = ctx.compose!;
        const proposal = postCompose(parseWith(ComposeSchema, text), c.hunks);
        if (!proposal.commits.length) throw new InvalidOutputError('The proposal had no usable commits.');
        return {
          ...proposal,
          source: req.source,
          diffHash: c.diff.hash,
          hunks: c.hunks,
        };
      }
      case 'explainCommits':
      case 'explainWip':
      case 'changelog':
        return { markdown: text.trim() };
      case 'explainBranch':
        return { markdown: text.trim(), ...(ctx.range ? { range: ctx.range } : {}) };
    }
  }

  // ---- changelog file ----

  /** Prepend to CHANGELOG.md at the worktree root (created if missing); after a leading `# ` title if any. */
  saveChangelog(repoId: RepoId, markdown: string): { path: string } {
    const root = this.d.git(repoId).repo.worktreeRoot;
    if (!root) throw new Error('A bare repository has no working tree.');
    const file = path.join(root, 'CHANGELOG.md');
    let existing = '';
    try {
      existing = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const add = `${markdown.trim()}\n`;
    let next: string;
    const title = /^# [^\n]*\n+/.exec(existing);
    if (!existing.trim()) next = `# Changelog\n\n${add}`;
    else if (title) next = `${title[0].replace(/\n+$/, '\n\n')}${add}\n${existing.slice(title[0].length)}`;
    else next = `${add}\n${existing}`;
    fs.writeFileSync(file, next, 'utf8');
    return { path: file };
  }
}

function addUsage(a?: AiUsage, b?: AiUsage): AiUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

/** Best-effort partial result while JSON streams (progressive fill of message fields). */
function partialFor(feature: AiFeature, text: string): unknown {
  switch (feature) {
    case 'commitMessage':
    case 'stashMessage': {
      const summary = partialStringField(text, 'summary');
      if (summary === undefined) return undefined;
      return { summary, description: partialStringField(text, 'description') ?? '' };
    }
    case 'prDraft': {
      const title = partialStringField(text, 'title');
      if (title === undefined) return undefined;
      return { title, body: partialStringField(text, 'body') ?? '' };
    }
    default:
      return undefined;
  }
}

export function toAiError(e: unknown): AiError {
  if (e instanceof AiProviderError) {
    return {
      code: e.code,
      message: e.message,
      ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
    };
  }
  if (e instanceof InvalidOutputError) return { code: 'invalid-output', message: e.message };
  if (e instanceof Error && e.name === 'AbortError') return { code: 'cancelled', message: 'Cancelled.' };
  const message = e instanceof Error ? e.message : String(e);
  return { code: 'provider', message: message.slice(0, 500) };
}
