import type { GitOperation } from '@githappens/git/ops';
import type { RepoId } from '@githappens/git/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { push } from '../../actions/git-actions';
import { useContextMenu } from '../../components/ContextMenu';
import { confirm, prompt } from '../../components/Dialogs';
import { invoke, IpcError } from '../../lib/api';
import { quiet, runOp } from '../../lib/ops';
import { useStatus } from '../../repo/queries';
import { useIsRunning } from '../../stores/ops';
import { useRepoUi, useRepoUiStore, type ComposerDraft } from '../../stores/repo-ui';
import { useSetting } from '../../stores/settings';
import { useToastStore } from '../../stores/toasts';
import { useCommitMessageAi } from '../ai/CommitMessageAi';
import { IdentityNotice } from '../../notifications/IdentityNotice';
import { useConflictState } from '../merge/conflict-queries';
import { stageAll } from '../composer/actions';
import { commitInvoke, commitInvokeOr, onHookOutput } from '../composer/api';
import { CoAuthorPicker } from '../composer/CoAuthorPicker';
import { EMPTY_HOOK, useComposer, useComposerStore } from '../composer/composer-store';
import {
  commitAction,
  commitButtonLabel,
  isPristine,
  prefillFromMessage,
  signFlag,
  splitPaste,
  summaryCounter,
  templateFields,
  trailersToAdd,
  type ComposerMode,
} from '../composer/helpers';
import { HookOutputDrawer } from '../composer/HookOutputDrawer';
import type { WipRow } from '../composer/staging-helpers';
import cs from '../composer/Composer.module.css';
import s from './StagingPanel.module.css';

/** Drafts are saved to main (per repo + branch) this long after the last edit (spec 06 §4.5). */
const DRAFT_SAVE_MS = 1000;

export interface CommitOptions {
  /** `git add -A` first (Ctrl/Cmd+Alt+Enter, ⋯ menu). */
  stageAll?: boolean;
  /** Push after a successful commit regardless of the toggle (Ctrl/Cmd+Shift+Enter). */
  push?: boolean;
  /** One-off `--no-verify` ("Commit skipping hooks"). */
  skipHooks?: boolean;
}

/**
 * Commit composer (spec 06 §4.5): summary (counter, paste splitting) + description, co-authors,
 * template, amend (pushed warning, restore on undo), skip hooks, push after commit, per-commit signing,
 * hook output drawer, merge/rebase/cherry-pick states, empty commit, reword HEAD, persisted drafts.
 */
export function CommitComposer({
  repoId,
  stagedCount,
  unstagedCount,
  staged = [],
}: {
  repoId: RepoId;
  stagedCount: number;
  unstagedCount: number;
  staged?: WipRow[];
}) {
  const qc = useQueryClient();
  const draft = useRepoUi(repoId, (u) => u.draft);
  const update = useRepoUiStore((st) => st.update);
  const extras = useComposer(repoId, (c) => c);
  const setExtras = useComposerStore((st) => st.update);
  const showMenu = useContextMenu((st) => st.show);
  const committing = useIsRunning(repoId, [
    'commit.create',
    'merge.continue',
    'rebase.continue',
    'sequencer.continue',
  ]);
  const summaryRef = useRef<HTMLInputElement>(null);
  const status = useStatus(repoId);
  const branch = status.data?.branch.head ?? null;
  const headOid = status.data?.branch.oid ?? null;
  const conflict = useConflictState(repoId).data;
  const autoTemplate = useSetting('commit.autoApplyTemplate') ?? true;
  const stripComments = useSetting('commit.stripComments') ?? true;
  const stickyCoAuthors = useSetting('commit.stickyCoAuthors') ?? false;
  const rememberSkip = useSetting('commit.rememberSkipHooks') ?? false;

  const setDraft = (patch: Partial<ComposerDraft>): void =>
    update(repoId, (u) => ({ draft: { ...u.draft, ...patch } }));
  const getDraft = (): ComposerDraft => useRepoUiStore.getState().get(repoId).draft;

  // ---- context: hooks, signing, HEAD pushed (refreshed when HEAD / upstream move) ----
  const ctx = useQuery({
    queryKey: [
      'commitContext',
      repoId,
      headOid,
      status.data?.branch.upstream ?? null,
      status.data?.branch.ahead ?? 0,
    ],
    queryFn: () =>
      commitInvokeOr(
        'commit:context',
        { repoId },
        { hooks: [], signByDefault: false, signingConfigured: false, headPushed: null, unborn: !headOid },
      ),
    staleTime: 30_000,
  });
  const template = useQuery({
    queryKey: ['commitTemplate', repoId],
    queryFn: () => commitInvokeOr('commit:template', { repoId }, {}),
    staleTime: 60_000,
  });
  const tplFields = template.data?.text ? templateFields(template.data.text, stripComments) : null;
  const stagedKey = staged.map((f) => f.path).join('\0');
  const eol = useQuery({
    queryKey: ['commitEol', repoId, stagedKey],
    queryFn: () => commitInvokeOr('commit:eolCheck', { repoId }, []),
    enabled: staged.length > 0,
    staleTime: 10_000,
  });

  // ---- draft persistence per repo + branch ----
  const loadedFor = useRef<string | null>(null);
  const [draftReady, setDraftReady] = useState<string | null>(null);
  const branchKey = `${branch ?? '(detached)'}`;
  useEffect(() => {
    if (status.isLoading || loadedFor.current === branchKey) return;
    const first = loadedFor.current === null;
    loadedFor.current = branchKey;
    let cancelled = false;
    void commitInvokeOr('commit:draft:get', { repoId, branch }, null).then((d) => {
      if (cancelled) return;
      setDraftReady(branchKey);
      const cur = getDraft();
      // first load: never clobber text typed in this session (it is newer than the stored draft)
      if (first && (cur.summary.trim() || cur.description.trim())) return;
      if (d) {
        setDraft({ summary: d.summary, description: d.description });
        setExtras(repoId, () => ({ coAuthors: d.coAuthors }));
      } else if (!first) {
        setDraft({ summary: '', description: '', amend: false });
        setExtras(repoId, (c) => ({ coAuthors: stickyCoAuthors ? c.coAuthors : [], preAmend: null }));
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, branchKey, status.isLoading]);

  useEffect(() => {
    if (loadedFor.current !== branchKey || draft.amend) return;
    const pristine = isPristine(draft, tplFields);
    const t = setTimeout(() => {
      void commitInvoke('commit:draft:set', {
        repoId,
        branch,
        draft:
          pristine && !extras.coAuthors.length
            ? null
            : { ...draft, coAuthors: extras.coAuthors, updatedAt: Date.now() },
      }).catch(() => undefined);
    }, DRAFT_SAVE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, branchKey, draft.summary, draft.description, draft.amend, extras.coAuthors]);

  // ---- template auto-apply ----
  useEffect(() => {
    if (!autoTemplate || !tplFields || draftReady !== branchKey || draft.amend || conflict?.op) return;
    const d = getDraft();
    if (!d.summary.trim() && !d.description.trim()) setDraft(tplFields);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTemplate, template.data?.text, conflict?.op, draftReady, branchKey]);

  // ---- MERGE_MSG / SQUASH_MSG / cherry-pick / rebase prefill ----
  const prefilled = useRef<string | null>(null);
  const squash = conflict?.op === 'merge' && conflict.incoming.label === 'Squashed changes';
  useEffect(() => {
    const msg = conflict?.message;
    if (!conflict?.op || !msg) return;
    const key = `${conflict.op}:${conflict.incoming.sha ?? ''}`;
    if (prefilled.current === key) return;
    prefilled.current = key;
    const d = getDraft();
    if (isPristine(d, tplFields)) setDraft({ ...prefillFromMessage(msg), amend: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflict?.op, conflict?.message, conflict?.incoming.sha]);

  // AI commit message (spec 12 §4.4): sparkle button, streamed fill, Ctrl+Z restores.
  const ai = useCommitMessageAi({ repoId, stagedCount, amend: draft.amend, draft, setDraft });

  // Ctrl+Shift+M focuses the message (spec 01 §4.9).
  useEffect(() => {
    const focus = (): void => summaryRef.current?.focus();
    window.addEventListener('kl:focus-commit-message', focus);
    return () => window.removeEventListener('kl:focus-commit-message', focus);
  }, []);

  // hook output streaming (spec 06 §4.6)
  useEffect(
    () => onHookOutput(repoId, (e) => useComposerStore.getState().appendHook(repoId, e.chunk)),
    [repoId],
  );

  const mode: ComposerMode = {
    op: conflict?.op ?? null,
    squash,
    amend: draft.amend,
    allowEmpty: extras.allowEmpty,
    stagedCount,
    push: extras.pushAfter,
  };
  const action = commitAction(mode);
  const conflicts = conflict?.conflicts.length ?? 0;
  const hasHooks = (ctx.data?.hooks ?? []).some((h) => h !== 'post-commit');
  const needsSummary = action === 'commit';
  const canCommit =
    !committing &&
    conflicts === 0 &&
    (!needsSummary || draft.summary.trim().length > 0) &&
    (action !== 'commit' || stagedCount > 0 || draft.amend || extras.allowEmpty || squash);

  const finishSuccess = (pushNow: boolean): void => {
    setDraft({ summary: '', description: '', amend: false, ...(rememberSkip ? {} : { skipHooks: false }) });
    setExtras(repoId, (c) => ({
      coAuthors: stickyCoAuthors ? c.coAuthors : [],
      allowEmpty: false,
      preAmend: null,
      sign: 'config',
      hook: c.hook.output.trim() ? { ...c.hook, running: false, failed: null, open: false } : EMPTY_HOOK,
    }));
    void commitInvoke('commit:draft:set', { repoId, branch, draft: null }).catch(() => undefined);
    void qc.invalidateQueries({ queryKey: ['commit', repoId] });
    void qc.invalidateQueries({ queryKey: ['commitContext', repoId] });
    if (pushNow) void push(repoId);
  };

  const commit = async (o: CommitOptions = {}): Promise<void> => {
    const d = getDraft();
    const x = useComposerStore.getState().get(repoId);
    if (needsSummary && !d.summary.trim()) {
      summaryRef.current?.focus();
      return;
    }
    if (o.stageAll && unstagedCount > 0) {
      if (!(await stageAll(repoId))) return;
    } else if (action === 'commit' && stagedCount === 0 && !d.amend && !x.allowEmpty && !squash) return;
    const skipHooks = o.skipHooks ?? d.skipHooks;
    const message = d.description.trim() ? `${d.summary.trim()}\n\n${d.description}` : d.summary.trim();
    let op: GitOperation;
    if (action === 'merge.continue') op = { type: 'merge.continue', message };
    else if (action === 'rebase.continue')
      op = { type: 'rebase.continue', ...(d.summary.trim() ? { message } : {}) };
    else if (action === 'sequencer.continue')
      op = { type: 'sequencer.continue', ...(d.summary.trim() ? { message } : {}) };
    else {
      if (d.amend && stagedCount === 0 && x.preAmend !== null) {
        const head = await invoke('git:commit:headMessage', { repoId }).catch(() => null);
        if (
          head &&
          head.summary === d.summary.trim() &&
          head.description.trim() === d.description.trim() &&
          !(await confirm('Nothing changed', 'Nothing changed, amend anyway?', 'Amend'))
        )
          return;
      }
      op = {
        type: 'commit.create',
        summary: d.summary.trim(),
        description: d.description,
        coAuthors: trailersToAdd(d.description, x.coAuthors),
        amend: d.amend,
        skipHooks,
        allowEmpty: x.allowEmpty || (d.amend && stagedCount === 0),
        sign: signFlag(x.sign),
        cleanup: stripComments ? 'strip' : 'whitespace',
      };
    }
    setExtras(repoId, () => ({
      hook: { running: hasHooks && !skipHooks, output: '', failed: null, open: false },
    }));
    try {
      const r = await runOp(repoId, op, { handled: ['HookFailed'] });
      if (!r) {
        setExtras(repoId, (c) => ({ hook: { ...c.hook, running: false } }));
        return;
      }
      const hookOutput = (r.data as { hookOutput?: string } | undefined)?.hookOutput;
      if (hookOutput && /post-commit/i.test(hookOutput)) {
        useToastStore.getState().push({
          kind: 'warning',
          title: 'post-commit hook reported output',
          body: hookOutput.slice(0, 400),
        });
      }
      finishSuccess(!!o.push || x.pushAfter);
    } catch (e) {
      if (e instanceof IpcError && e.code === 'HookFailed') {
        const det = e.error.details ?? {};
        const output = typeof det.output === 'string' ? det.output : e.error.stderr;
        setExtras(repoId, (c) => ({
          hook: {
            running: false,
            open: true,
            output: c.hook.output.trim() ? c.hook.output : output,
            failed: {
              hook: typeof det.hook === 'string' ? det.hook : 'pre-commit',
              exitCode: typeof det.exitCode === 'number' ? det.exitCode : e.error.exitCode,
              message: e.error.message,
            },
          },
        }));
      } else setExtras(repoId, (c) => ({ hook: { ...c.hook, running: false } }));
    }
  };

  // Ctrl+Enter commit, Ctrl+Shift+Enter commit & push, Ctrl+Alt+Enter stage all & commit (dispatched globally).
  useEffect(() => {
    const onCommit = (e: Event): void => {
      const d = (e as CustomEvent<CommitOptions | undefined>).detail ?? {};
      void commit({ stageAll: d.stageAll, push: d.push });
    };
    window.addEventListener('kl:commit', onCommit);
    return () => window.removeEventListener('kl:commit', onCommit);
  });

  // ---- amend ----
  const toggleAmend = async (amend: boolean): Promise<void> => {
    const d = getDraft();
    if (amend) {
      setExtras(repoId, () => ({ preAmend: { summary: d.summary, description: d.description } }));
      if (isPristine(d, tplFields)) {
        const head = await invoke('git:commit:headMessage', { repoId }).catch(() => null);
        setDraft({ amend, ...(head ? { summary: head.summary, description: head.description } : {}) });
      } else setDraft({ amend });
    } else {
      const prev = useComposerStore.getState().get(repoId).preAmend;
      setDraft({ amend: false, ...(prev ?? {}) });
      setExtras(repoId, () => ({ preAmend: null }));
    }
  };

  const rewordHead = async (): Promise<void> => {
    const head = await invoke('git:commit:headMessage', { repoId }).catch(() => null);
    if (!head) return;
    const initial = head.description ? `${head.summary}\n\n${head.description}` : head.summary;
    const r = await prompt({
      title: 'Edit HEAD commit message',
      label: ctx.data?.headPushed
        ? `HEAD is on ${ctx.data.headPushed.upstream} — rewording requires a force push.`
        : 'Commit message (staged changes are not included)',
      initial,
      multiline: true,
      okLabel: 'Update message',
      validate: (v) => (v.trim() ? null : 'The commit message cannot be empty.'),
    });
    if (!r) return;
    const text = r.value.replace(/\r\n/g, '\n');
    const nl = text.indexOf('\n');
    const summary = nl < 0 ? text.trim() : text.slice(0, nl).trim();
    const description = nl < 0 ? '' : text.slice(nl + 1).replace(/^\n+/, '');
    quiet(
      runOp(
        repoId,
        { type: 'commit.rewordHead', summary, description },
        { successToast: 'Commit message updated' },
      ),
    );
  };

  const saveTemplate = (): void => {
    const d = getDraft();
    const text = d.description.trim() ? `${d.summary}\n\n${d.description}` : d.summary;
    if (!text.trim()) return;
    void runOp(
      repoId,
      { type: 'commit.saveTemplate', scope: 'repo', text },
      { successToast: 'Saved as commit template' },
    )
      .then(() => qc.invalidateQueries({ queryKey: ['commitTemplate', repoId] }))
      .catch(() => undefined);
  };

  const moreMenu = (x: number, y: number): void =>
    showMenu(x, y, [
      {
        label: 'Stage all and commit',
        shortcut: 'Ctrl+Alt+Enter',
        disabled: unstagedCount === 0 || action !== 'commit',
        onSelect: () => void commit({ stageAll: true }),
      },
      {
        label: 'Commit and push',
        shortcut: 'Ctrl+Shift+Enter',
        disabled: !canCommit || action !== 'commit',
        onSelect: () => void commit({ push: true }),
      },
      {
        label: `${extras.allowEmpty ? '✓ ' : ''}Allow empty commit`,
        disabled: action !== 'commit',
        onSelect: () => setExtras(repoId, (c) => ({ allowEmpty: !c.allowEmpty })),
      },
      'separator',
      {
        label: 'Edit HEAD commit message…',
        disabled: !!ctx.data?.unborn || !!conflict?.op,
        onSelect: () => void rewordHead(),
      },
      'separator',
      {
        label: 'Apply commit template',
        disabled: !tplFields,
        onSelect: () => tplFields && setDraft(tplFields),
      },
      {
        label: 'Save message as template',
        disabled: !draft.summary.trim() && !draft.description.trim(),
        onSelect: saveTemplate,
      },
    ]);

  const counter = summaryCounter(draft.summary);
  const signed = extras.sign === 'config' ? !!ctx.data?.signByDefault : extras.sign === 'on';
  const label = committing
    ? extras.hook.running
      ? 'Running hooks…'
      : action === 'commit'
        ? 'Committing…'
        : 'Continuing…'
    : commitButtonLabel(mode);
  const eolIssues = eol.data ?? [];

  return (
    <form
      className={s.composer}
      aria-label="Commit"
      onSubmit={(e) => {
        e.preventDefault();
        void commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.stopPropagation();
          void commit(e.altKey ? { stageAll: true } : e.shiftKey ? { push: true } : {});
        }
      }}
    >
      {conflict?.op && conflict.message !== undefined && (
        <span className={cs.prefill}>
          {squash
            ? 'Prefilled from SQUASH_MSG'
            : conflict.op === 'merge'
              ? 'Prefilled from MERGE_MSG'
              : `Message of the commit being ${conflict.op === 'rebase' ? 'rebased' : 'applied'}`}
        </span>
      )}
      <div className={s.summaryRow}>
        <input
          ref={summaryRef}
          type="text"
          aria-label="Commit summary"
          placeholder="Summary"
          value={draft.summary}
          onChange={(e) => {
            ai.noteEdit('summary');
            setDraft({ summary: e.target.value });
          }}
          onPaste={(e) => {
            const el = e.currentTarget;
            const r = splitPaste(e.clipboardData.getData('text'), {
              summary: draft.summary,
              description: draft.description,
              selStart: el.selectionStart ?? draft.summary.length,
              selEnd: el.selectionEnd ?? draft.summary.length,
            });
            if (!r) return;
            e.preventDefault();
            ai.noteEdit('summary');
            setDraft({ summary: r.summary, description: r.description });
            requestAnimationFrame(() => el.setSelectionRange(r.caret, r.caret));
          }}
          onKeyDown={(e) => ai.onKeyDown('summary', e)}
        />
        {ai.button}
        <span
          className={`${cs.counter} ${counter.tone === 'over' ? cs.over : counter.tone === 'warn' ? cs.warn : ''}`}
          title={counter.title}
          aria-label={`Summary length ${counter.text}`}
        >
          {counter.text}
        </span>
      </div>
      <textarea
        aria-label="Commit description"
        placeholder="Description"
        rows={4}
        value={draft.description}
        onChange={(e) => {
          ai.noteEdit('description');
          setDraft({ description: e.target.value });
        }}
        onKeyDown={(e) => ai.onKeyDown('description', e)}
      />
      {ai.status}
      <CoAuthorPicker
        repoId={repoId}
        value={extras.coAuthors}
        onChange={(v) => setExtras(repoId, () => ({ coAuthors: v }))}
      />
      <div className={s.options}>
        <label title={conflict?.op ? 'Not available while an operation is in progress' : undefined}>
          <input
            type="checkbox"
            checked={draft.amend}
            disabled={!!conflict?.op || !!ctx.data?.unborn}
            onChange={(e) => void toggleAmend(e.target.checked)}
          />{' '}
          Amend
        </label>
        <label title="Commit without running pre-commit / commit-msg hooks (--no-verify)">
          <input
            type="checkbox"
            checked={draft.skipHooks}
            onChange={(e) => setDraft({ skipHooks: e.target.checked })}
          />{' '}
          Skip hooks
        </label>
        <label title="Push the branch right after committing (Ctrl+Shift+Enter commits and pushes once)">
          <input
            type="checkbox"
            checked={extras.pushAfter}
            onChange={(e) => useComposerStore.getState().setPushAfter(repoId, e.target.checked)}
          />{' '}
          Push
        </label>
        {ctx.data?.signingConfigured && (
          <label
            title={`Sign this commit (${extras.sign === 'config' ? 'following commit.gpgSign' : extras.sign === 'on' ? '-S' : '--no-gpg-sign'})`}
          >
            <input
              type="checkbox"
              checked={signed}
              onChange={(e) => setExtras(repoId, () => ({ sign: e.target.checked ? 'on' : 'off' }))}
            />{' '}
            Sign
          </label>
        )}
      </div>
      {draft.amend && ctx.data?.headPushed && (
        <p className={cs.notice} role="status">
          This commit is on {ctx.data.headPushed.upstream} — amending will require force push.
        </p>
      )}
      {extras.allowEmpty && action === 'commit' && stagedCount === 0 && (
        <p className={cs.notice}>Empty commit: no file changes will be recorded.</p>
      )}
      {conflicts > 0 && (
        <p className={cs.notice}>
          Resolve {conflicts} conflicted file{conflicts === 1 ? '' : 's'} first.
        </p>
      )}
      {eolIssues.length > 0 && (
        <span
          className={cs.badge}
          title={eolIssues
            .map((i) => `${i.path} (${i.eol === 'mixed' ? 'mixed line endings' : 'CRLF'})`)
            .join('\n')}
        >
          {eolIssues.some((i) => i.eol === 'mixed') ? 'Mixed/CRLF' : 'CRLF'} line endings in{' '}
          {eolIssues.length} staged file{eolIssues.length === 1 ? '' : 's'}
        </span>
      )}
      <IdentityNotice repoId={repoId} />
      <HookOutputDrawer
        repoId={repoId}
        onRetry={() => void commit()}
        onSkipHooks={() => void commit({ skipHooks: true })}
      />
      <div className={cs.buttonRow}>
        <button
          type="submit"
          className={`primary ${s.commitBtn}`}
          disabled={!canCommit}
          title={extras.pushAfter ? 'Ctrl+Enter' : 'Ctrl+Enter · Ctrl+Shift+Enter commits and pushes'}
        >
          {label}
        </button>
        <button
          type="button"
          className={cs.moreBtn}
          aria-label="More commit options"
          title="More commit options"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            moreMenu(r.left, r.top - 4);
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    </form>
  );
}
