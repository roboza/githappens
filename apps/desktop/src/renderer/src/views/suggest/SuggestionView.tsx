import type { RepoId } from '@githappens/git/types';
import { createElement, useEffect, useMemo, useRef, useState } from 'react';

import type {
  OpenedSuggestion,
  SuggestApplyTarget,
  SuggestionInfo,
  SuggestPr,
} from '../../../../shared/ipc/suggest-contract';
import { mountDialog } from '../../ai/mount';
import { errorText, extrasInvoke } from '../../cloud/extras-api';
import { useToastStore } from '../../stores/toasts';
import { DiffPreview } from './DiffPreview';
import s from './Suggest.module.css';

/**
 * SuggestionView (spec 14 §4.3): per-file diff with accept/reject, then Apply to current branch · Apply to
 * new branch · Commit & push to PR branch · Dismiss. Opened from the SuggestionsBox or a deep link.
 */
export function openSuggestionView(o: {
  repoId: RepoId;
  info?: SuggestionInfo;
  url?: string;
  pr?: SuggestPr;
}): Promise<void> {
  return mountDialog<void>((done) => createElement(SuggestionView, { ...o, onClose: () => done() }));
}

function SuggestionView({
  repoId,
  info,
  url,
  pr,
  onClose,
}: {
  repoId: RepoId;
  info?: SuggestionInfo;
  url?: string;
  pr?: SuggestPr;
  onClose(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [opened, setOpened] = useState<OpenedSuggestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [branchName, setBranchName] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    let live = true;
    extrasInvoke('suggest:open', {
      ...(info ? { info } : {}),
      ...(url ? { url } : {}),
      ...(pr ? { prHeadSha: pr.headSha } : {}),
    }).then(
      (o) => live && setOpened(o),
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [info, url, pr]);

  const accepted = useMemo(
    () => (opened ? opened.files.map((f) => f.path).filter((p) => !rejected.has(p)) : []),
    [opened, rejected],
  );
  const suggestion = opened?.suggestion ?? info;

  const apply = async (target: SuggestApplyTarget): Promise<void> => {
    if (!opened || !suggestion) return;
    setBusy(true);
    setError(null);
    try {
      const r = await extrasInvoke('suggest:apply', {
        repoId,
        patchId: suggestion.patchId,
        paths: accepted,
        target,
        ...(suggestion.id ? { suggestionId: suggestion.id } : {}),
        title: opened.title,
        ...(suggestion.coAuthor ? { coAuthor: suggestion.coAuthor } : {}),
      });
      const toasts = useToastStore.getState();
      if (r.conflicts.length || r.rejects.length) {
        toasts.push({
          kind: 'warning',
          title: 'Suggestion applied with conflicts',
          body: [...r.conflicts, ...r.rejects].join(', '),
        });
      } else {
        toasts.push({
          kind: 'success',
          title: r.pushed ? 'Suggestion committed and pushed' : 'Suggestion applied',
          ...(r.branch ? { body: `On ${r.branch}${r.commit ? ` (${r.commit.slice(0, 7)})` : ''}` } : {}),
        });
      }
      for (const w of r.warnings) toasts.push({ kind: 'info', title: w });
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (): Promise<void> => {
    if (suggestion?.id) {
      try {
        await extrasInvoke('suggest:setStatus', { id: suggestion.id, status: 'dismissed' });
      } catch (e) {
        setError(errorText(e));
        return;
      }
    }
    onClose();
  };

  const file = opened?.files[selected];
  const canPush = !!pr && !pr.isCrossRepository;

  return (
    <dialog
      ref={ref}
      className={`${s.dialog} ${s.wide}`}
      aria-label="Code suggestion"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 className={s.title}>
        💡 {opened?.title ?? suggestion?.title ?? 'Code suggestion'}
        {suggestion?.author.login || suggestion?.author.name ? (
          <span className={s.muted}>by {suggestion.author.login ?? suggestion.author.name}</span>
        ) : null}
      </h2>
      <div className={s.body} style={{ flex: 1 }}>
        {opened?.description && <p className={s.muted}>{opened.description}</p>}
        {opened?.outdated && (
          <p className={s.warn}>
            Based on older head {opened.outdated.suggestedOn.slice(0, 7)} (the PR is now at{' '}
            {opened.outdated.currentHead.slice(0, 7)}); it is applied with a 3-way merge.
          </p>
        )}
        {suggestion?.missingKey && (
          <p className={s.warn}>
            This suggestion is encrypted and its link has no key; ask for the full link.
          </p>
        )}
        {!opened && !error && <p className={s.muted}>Loading suggestion…</p>}
        {opened && (
          <div className={s.split}>
            <ul className={s.fileList} role="listbox" aria-label="Files">
              {opened.files.map((f, i) => (
                <li
                  key={f.path}
                  role="option"
                  aria-selected={i === selected}
                  data-rejected={rejected.has(f.path)}
                  className={s.fileItem}
                  onClick={() => setSelected(i)}
                >
                  <input
                    type="checkbox"
                    aria-label={`Accept ${f.path}`}
                    title={rejected.has(f.path) ? 'Rejected: will not be applied' : 'Accepted'}
                    checked={!rejected.has(f.path)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      setRejected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.delete(f.path);
                        else next.add(f.path);
                        return next;
                      })
                    }
                  />
                  <span className={s.status}>{f.status}</span>
                  <span className={s.fileName} title={f.path}>
                    {f.path}
                  </span>
                  <span className={s.add}>+{f.additions}</span>
                  <span className={s.del}>−{f.deletions}</span>
                </li>
              ))}
            </ul>
            <DiffPreview diff={opened.diff[selected]} />
          </div>
        )}
        {file && (
          <div className={s.buttons} style={{ justifyContent: 'flex-start' }}>
            <button
              type="button"
              onClick={() => setRejected((p) => new Set([...p].filter((x) => x !== file.path)))}
              disabled={!rejected.has(file.path)}
            >
              Accept file
            </button>
            <button
              type="button"
              onClick={() => setRejected((p) => new Set([...p, file.path]))}
              disabled={rejected.has(file.path)}
            >
              Reject file
            </button>
            <span className={s.muted}>
              {accepted.length} of {opened?.files.length ?? 0} files accepted
            </span>
          </div>
        )}
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        {branchName !== null && (
          <form
            className={s.buttons}
            onSubmit={(e) => {
              e.preventDefault();
              if (branchName.trim()) void apply({ kind: 'new-branch', name: branchName.trim() });
            }}
          >
            <label className={s.field} style={{ flex: 1 }}>
              New branch name
              <input autoFocus value={branchName} onChange={(e) => setBranchName(e.target.value)} />
            </label>
            <button
              type="submit"
              className="primary"
              disabled={busy || !branchName.trim() || !accepted.length}
            >
              Create branch & apply
            </button>
          </form>
        )}
        <div className={s.buttons}>
          <button type="button" onClick={() => void dismiss()} disabled={busy} title="Mark as dismissed">
            Dismiss
          </button>
          <span className={s.spacer} />
          <button type="button" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button
            type="button"
            onClick={() => void apply({ kind: 'current' })}
            disabled={busy || !opened || !accepted.length}
          >
            Apply to current branch
          </button>
          <button
            type="button"
            onClick={() =>
              setBranchName(
                branchName ??
                  `suggestion/${(opened?.title ?? 'change')
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .slice(0, 40)}`,
              )
            }
            disabled={busy || !opened || !accepted.length}
          >
            Apply to new branch…
          </button>
          {canPush && (
            <button
              type="button"
              className="primary"
              onClick={() => void apply({ kind: 'pr-branch', pr: pr! })}
              disabled={busy || !opened || !accepted.length}
              title={`Commit on ${pr!.headBranch} with a Co-authored-by trailer and push`}
            >
              Commit & push to PR branch
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
