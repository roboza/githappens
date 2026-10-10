import type { ComposeSource } from '@githappens/git/ops';
import type { RepoId } from '@githappens/git/types';

/**
 * AI IPC (spec 12 §5). Bring-your-own-key: API keys go renderer → main once (`ai:key:set`) and never come
 * back; the renderer only learns `{ hasKey, last4 }`. Results stream on `ai:event` keyed by `requestId`,
 * which the renderer generates so it can subscribe before starting the request.
 */

export type AiProviderId = 'anthropic' | 'openai' | 'azure-openai' | 'gemini' | 'openai-compatible';
export type AiFeature =
  | 'commitMessage'
  | 'explainCommits'
  | 'explainBranch'
  | 'explainWip'
  | 'stashMessage'
  | 'conflictResolve'
  | 'prDraft'
  | 'composeCommits'
  | 'changelog';
export type AiEffort = 'low' | 'medium' | 'high';

/**
 * Per-feature settings groups (spec 12 §2.2 / §4.5): effort overrides and custom instructions are set per
 * group ("Explain" covers commits, branch and WIP). Stored as `ai.effortOverrides` / `ai.featureInstructions`.
 */
export type AiFeatureGroup = 'commit' | 'explain' | 'stash' | 'pr' | 'conflicts' | 'composer' | 'changelog';
export const AI_FEATURE_GROUPS = [
  'commit',
  'explain',
  'stash',
  'pr',
  'conflicts',
  'composer',
  'changelog',
] as const satisfies readonly AiFeatureGroup[];
export const AI_EFFORTS = ['low', 'medium', 'high'] as const satisfies readonly AiEffort[];

export const AI_FEATURE_GROUP_OF: Record<AiFeature, AiFeatureGroup> = {
  commitMessage: 'commit',
  explainCommits: 'explain',
  explainBranch: 'explain',
  explainWip: 'explain',
  stashMessage: 'stash',
  prDraft: 'pr',
  conflictResolve: 'conflicts',
  composeCommits: 'composer',
  changelog: 'changelog',
};

/** Label and default effort per group (low for messages, medium for explain/PR/changelog, high for conflicts/composer). */
export const AI_FEATURE_GROUP_INFO: Record<AiFeatureGroup, { label: string; defaultEffort: AiEffort }> = {
  commit: { label: 'Commit messages', defaultEffort: 'low' },
  explain: { label: 'Explain (commits, branch, changes)', defaultEffort: 'medium' },
  stash: { label: 'Stash messages', defaultEffort: 'low' },
  pr: { label: 'Pull request drafts', defaultEffort: 'medium' },
  conflicts: { label: 'Conflict resolution', defaultEffort: 'high' },
  composer: { label: 'Commit Composer', defaultEffort: 'high' },
  changelog: { label: 'Changelog', defaultEffort: 'medium' },
};

/** Settings edited by Preferences → AI's custom panel (AiPrefsPanel); hide them from the generic rows. */
export const AI_PANEL_SETTING_KEYS = [
  'ai.enabled',
  'ai.provider',
  'ai.model',
  'ai.baseUrl',
  'ai.effort',
  'ai.consent',
  'ai.effortOverrides',
  'ai.featureInstructions',
] as const;

export type AiEffortOverrides = Partial<Record<AiFeatureGroup, AiEffort>>;
export type AiFeatureInstructions = Partial<Record<AiFeatureGroup, string>>;

export interface AiRequestBase {
  requestId: string;
  repoId: RepoId;
}

/** One conflicted region of the merge tool (spec 08 `Segment`), sent as-is so proposals key by its id. */
export interface AiConflictHunk {
  hunkId: string;
  ours: string;
  theirs: string;
  base?: string;
}

export type AiRequest =
  | (AiRequestBase & {
      feature: 'commitMessage';
      amend?: boolean;
      hint?: 'shorter' | 'conventional';
      /** The message currently in the composer (regenerate "shorter" refers to it). */
      current?: string;
      /**
       * Message for an existing commit instead of the staged changes ("Reword with AI" in the interactive
       * rebase view): the context is that commit's diff, with its current message as a hint. `amend` is ignored.
       */
      sha?: string;
    })
  | (AiRequestBase & { feature: 'explainCommits'; shas: string[] })
  | (AiRequestBase & { feature: 'explainBranch'; branch: string; base?: string })
  | (AiRequestBase & { feature: 'explainWip' })
  | (AiRequestBase & { feature: 'stashMessage' })
  | (AiRequestBase & { feature: 'conflictResolve'; path: string; hunks: AiConflictHunk[] })
  | (AiRequestBase & { feature: 'prDraft'; head: string; base: string; template?: string })
  | (AiRequestBase & { feature: 'composeCommits'; source: ComposeSource })
  | (AiRequestBase & {
      feature: 'changelog';
      from: string;
      to: string;
      format: 'keepachangelog' | 'grouped' | 'plain';
    });

export interface CommitMessageResult {
  summary: string;
  description: string;
}
export interface ExplainResult {
  markdown: string;
  /** Range header for explainBranch ("12 commits, 34 files vs main"). */
  range?: { base: string; baseRef: string; commits: number; files: number };
}
export interface ConflictProposal {
  hunkId: string;
  resolvedText: string;
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
  /** Set when post-processing changed the proposal (e.g. markers found → downgraded to low). */
  warning?: string;
}
export interface ConflictResult {
  proposals: ConflictProposal[];
}
export interface ComposeHunkRef {
  path: string;
  hunkId: string;
}
/** A hunk chip of the Commit Composer (spec 12 §4.6). */
export interface ComposeHunkInfo extends ComposeHunkRef {
  kind: 'hunk' | 'file';
  status: 'A' | 'D' | 'M';
  binary: boolean;
  header: string;
  additions: number;
  deletions: number;
  /** Patch text for the preview (capped). */
  preview: string;
}
export interface ComposeProposal {
  commits: { summary: string; description: string; hunks: ComposeHunkRef[] }[];
  unassigned: ComposeHunkRef[];
}
export interface ComposeResult extends ComposeProposal {
  source: ComposeSource;
  /** Pass back in the `ai.compose` op; the op refuses when the diff changed. */
  diffHash: string;
  hunks: ComposeHunkInfo[];
}
export interface PrDraftResult {
  title: string;
  body: string;
}
export interface ChangelogResult {
  markdown: string;
}

export interface AiFeatureResults {
  commitMessage: CommitMessageResult;
  stashMessage: CommitMessageResult;
  explainCommits: ExplainResult;
  explainBranch: ExplainResult;
  explainWip: ExplainResult;
  conflictResolve: ConflictResult;
  prDraft: PrDraftResult;
  composeCommits: ComposeResult;
  changelog: ChangelogResult;
}

export type AiErrorCode =
  | 'disabled'
  | 'repo-disabled'
  | 'consent'
  | 'no-key'
  | 'auth'
  | 'rate-limit'
  | 'too-large'
  | 'refused'
  | 'network'
  | 'provider'
  | 'cancelled'
  | 'invalid-output'
  | 'nothing';

export interface AiError {
  code: AiErrorCode;
  message: string;
  retryAfterMs?: number;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiStreamEvent {
  requestId: string;
  /** `delta`: streamed text (markdown features) and/or a best-effort partial structured result. */
  kind: 'delta' | 'done' | 'error';
  text?: string;
  /** Partial structured result while streaming (commit/stash message, PR draft). */
  partial?: unknown;
  /** Generation restarted (retry after max_tokens / repair): drop text and partials received so far. */
  reset?: boolean;
  /** `done`: the feature's result (`AiFeatureResults[feature]`). */
  result?: unknown;
  error?: AiError;
  usage?: AiUsage;
  /** The context was truncated to fit the size budget ("based on a partial diff"). */
  truncated?: boolean;
  /** Files left out (excluded globs, binary) — listed by name only. */
  omitted?: string[];
}

export interface AiStatus {
  enabled: boolean;
  /** A key is stored (or the provider needs none: local OpenAI-compatible servers). */
  configured: boolean;
  provider: AiProviderId;
  /** Effective model ('' setting → provider default). */
  model: string;
  /** Where requests go (shown in the consent dialog). */
  endpoint: string;
  /** Value to store in `ai.consent` after the user agrees. */
  consentKey: string;
  needsConsent: boolean;
  /** `githappens.ai=false` in the repo's git config. */
  repoDisabled?: boolean;
}

export interface AiKeyStatus {
  hasKey: boolean;
  last4?: string;
}

export interface AiIpcContract {
  'ai:run': { req: AiRequest; res: { requestId: string } };
  'ai:cancel': { req: { requestId: string }; res: void };
  'ai:status': { req: { repoId?: RepoId }; res: AiStatus };
  /** Sends a tiny request with the given (or current) provider settings and the stored key. */
  'ai:testConnection': {
    req: { provider?: AiProviderId; model?: string; baseUrl?: string };
    res: { ok: boolean; latencyMs: number; error?: AiError };
  };
  'ai:key:set': { req: { provider: AiProviderId; key: string }; res: AiKeyStatus };
  'ai:key:clear': { req: { provider: AiProviderId }; res: AiKeyStatus };
  'ai:key:status': { req: { provider?: AiProviderId }; res: AiKeyStatus };
  /** Prepend markdown to the repo's CHANGELOG.md (created if missing); a normal WIP change. */
  'ai:changelog:save': { req: { repoId: RepoId; markdown: string }; res: { path: string } };
}

export interface AiEventContract {
  'ai:event': AiStreamEvent;
}

export const AI_INVOKE_CHANNELS = [
  'ai:run',
  'ai:cancel',
  'ai:status',
  'ai:testConnection',
  'ai:key:set',
  'ai:key:clear',
  'ai:key:status',
  'ai:changelog:save',
] as const satisfies readonly (keyof AiIpcContract)[];

export const AI_EVENT_CHANNELS = ['ai:event'] as const satisfies readonly (keyof AiEventContract)[];

/** Provider defaults (the only place model ids are hard-coded). */
export const AI_DEFAULT_MODELS: Record<AiProviderId, string> = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-4.1-mini',
  'azure-openai': '',
  gemini: 'gemini-2.5-flash',
  'openai-compatible': '',
};

/** Suggestions for the model field (free text is allowed). */
export const AI_MODEL_SUGGESTIONS: Record<AiProviderId, string[]> = {
  anthropic: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
  openai: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-5'],
  'azure-openai': [],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  'openai-compatible': ['llama3.1', 'qwen2.5-coder'],
};

export const AI_DEFAULT_ENDPOINTS: Record<AiProviderId, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  'azure-openai': '',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  'openai-compatible': 'http://localhost:11434/v1',
};

export const AI_PROVIDER_LABELS: Record<AiProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'azure-openai': 'Azure OpenAI',
  gemini: 'Google Gemini',
  'openai-compatible': 'OpenAI-compatible (Ollama, LM Studio…)',
};
