import type { RepoId } from '@githappens/git/types';
import { ChevronDown, ChevronRight, CloudUpload, Copy, ExternalLink, TriangleAlert } from 'lucide-react';
import { createElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type {
  PatchAvailability,
  PatchCreateRes,
  PatchDraft,
  PatchFile,
  PatchSource,
  PatchVisibility,
  UserRef,
} from '../../../../shared/ipc/patches-contract';
import { mountDialog } from '../../ai/mount';
import { copyText, errorText, patchInvoke } from '../../cloud-patches/api';
import { buildTree, type TreeNode } from '../../lib/format';
import { useToastStore } from '../../stores/toasts';
import s from './CloudPatches.module.css';

const EXPIRY: { value: number | null; label: string }[] = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: null, label: 'Never' },
];

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Open the Create Cloud Patch dialog (spec 14 §4.2). Resolves when it closes. */
/** Prefill for the dialog; `collaborators` (org user ids) preselects "Specific people". */
export interface CreatePatchDefaults {
  title?: string;
  collaborators?: string[];
}

export function openCreateCloudPatch(
  repoId: RepoId,
  source: PatchSource,
  defaults: CreatePatchDefaults = {},
): Promise<PatchCreateRes | null> {
  return mountDialog<PatchCreateRes | null>((done) =>
    createElement(CreateCloudPatchDialog, { repoId, source, defaults, onClose: done }),
  );
}

/**
 * CreateCloudPatchDialog: title/description, contents (staged only vs all changes for WIP) with a file
 * tree of checkboxes, visibility (link / org / specific people), expiry, end-to-end encryption. Create →
 * the link is copied and shown with Copy / Open.
 */
export function CreateCloudPatchDialog({
  repoId,
  source: initialSource,
  defaults,
  onClose,
}: {
  repoId: RepoId;
  source: PatchSource;
  defaults: CreatePatchDefaults;
  onClose(result: PatchCreateRes | null): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const isWip = initialSource.kind === 'wip';
  const [stagedOnly, setStagedOnly] = useState(initialSource.kind === 'wip' && initialSource.stagedOnly);
  // preview per contents choice, so switching never shows stale files
  const [preview, setPreview] = useState<{ stagedOnly: boolean; draft?: PatchDraft; error?: string } | null>(
    null,
  );
  const current = preview?.stagedOnly === stagedOnly ? preview : null;
  const draft = current?.draft ?? null;
  const loadError = current?.error ?? null;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState(defaults.title ?? '');
  const [titleTouched, setTitleTouched] = useState(!!defaults.title);
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<PatchVisibility>(
    defaults.collaborators?.length ? 'collaborators' : 'link',
  );
  const [expires, setExpires] = useState<number | null>(30);
  const [e2e, setE2e] = useState(true);
  const [e2eTouched, setE2eTouched] = useState(false);
  const [people, setPeople] = useState<Set<string>>(() => new Set(defaults.collaborators ?? []));
  const [members, setMembers] = useState<UserRef[] | null>(null);
  const [avail, setAvail] = useState<PatchAvailability | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<PatchCreateRes | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    void patchInvoke('patch:availability', {}).then(setAvail, () => undefined);
  }, []);

  // preview of what would be shared; WIP re-reads when switching staged-only / all
  useEffect(() => {
    let live = true;
    const source: PatchSource = initialSource.kind === 'wip' ? { kind: 'wip', stagedOnly } : initialSource;
    patchInvoke('patch:preview', { repoId, source }).then(
      (d) => {
        if (!live) return;
        setPreview({ stagedOnly, draft: d });
        setSelected(new Set(d.files.map((f) => f.path)));
        if (!titleTouched) setTitle(d.title);
      },
      (e: unknown) => {
        if (!live) return;
        // nothing staged: fall back to all working changes
        if (initialSource.kind === 'wip' && stagedOnly && /no changes/i.test(errorText(e)))
          setStagedOnly(false);
        else setPreview({ stagedOnly, error: errorText(e) });
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, stagedOnly]);

  useEffect(() => {
    if (visibility !== 'collaborators' || members) return;
    patchInvoke('patch:collaboratorCandidates', {}).then(
      (r) => setMembers(r.members),
      (e: unknown) => {
        setMembers([]);
        setError(errorText(e));
      },
    );
  }, [visibility, members]);

  const changeVisibility = (v: PatchVisibility): void => {
    setVisibility(v);
    if (!e2eTouched) setE2e(v === 'link');
  };

  const files = draft?.files ?? [];
  const allSelected = selected.size === files.length;
  const hasOrg = (avail?.orgs.length ?? 0) > 0;
  const orgName = avail?.orgs.find((o) => o.id === avail.activeOrgId)?.name ?? avail?.orgs[0]?.name;
  const tooBig = !!draft && draft.size > draft.maxBytes * 8; // raw text; the limit applies after gzip

  const create = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const paths = isWip && !allSelected ? [...selected] : undefined;
    const source: PatchSource =
      initialSource.kind === 'wip' ? { kind: 'wip', stagedOnly, ...(paths ? { paths } : {}) } : initialSource;
    try {
      const res = await patchInvoke('patch:create', {
        repoId,
        source,
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        visibility,
        ...(visibility === 'collaborators' ? { collaborators: [...people] } : {}),
        expiresInDays: expires,
        e2e,
      });
      copyText(res.shareUrl);
      useToastStore.getState().push({
        kind: 'success',
        title: 'Cloud Patch created',
        body: `Link copied to the clipboard.${res.warnings.length ? `\n${res.warnings.join('\n')}` : ''}`,
      });
      setCreated(res);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const close = (): void => onClose(created);

  if (created) {
    return (
      <dialog ref={ref} className={s.dialog} aria-label="Cloud Patch created" onClose={close}>
        <h2 className={s.dialogTitle}>
          <CloudUpload size={16} /> Cloud Patch created
        </h2>
        <div className={s.dialogBody}>
          <p className={s.muted}>
            Anyone{' '}
            {visibility === 'link'
              ? 'with this link'
              : visibility === 'org'
                ? `in ${orgName ?? 'your organization'}`
                : 'you selected'}{' '}
            can open the patch.
            {created.patch.e2e && ' The link contains the decryption key; the server cannot read the patch.'}
          </p>
          <div className={s.linkBox}>
            <input
              className={s.input}
              readOnly
              value={created.shareUrl}
              aria-label="Cloud Patch link"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" onClick={() => copyText(created.shareUrl)} title="Copy link">
              <Copy size={14} /> Copy link
            </button>
          </div>
          <div className={s.buttons}>
            <button
              type="button"
              onClick={() => {
                close();
                void import('../../cloud-patches/actions').then((m) => m.openPatchLink(created.deepLink));
              }}
            >
              <ExternalLink size={14} /> Open
            </button>
            <button type="button" className="primary" onClick={close}>
              Done
            </button>
          </div>
        </div>
      </dialog>
    );
  }

  const canCreate =
    !!draft &&
    !busy &&
    !!title.trim() &&
    selected.size > 0 &&
    !tooBig &&
    (visibility !== 'collaborators' || people.size > 0);

  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-label="Share as Cloud Patch"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <h2 className={s.dialogTitle}>
        <CloudUpload size={16} /> Share{' '}
        {initialSource.kind === 'commit' ? 'commit' : initialSource.kind === 'stash' ? 'stash' : 'changes'} as
        Cloud Patch
      </h2>
      <form
        className={s.dialogBody}
        onSubmit={(e) => {
          e.preventDefault();
          if (canCreate) void create();
        }}
      >
        <label className={s.field}>
          Title
          <input
            className={s.input}
            value={title}
            autoFocus
            onChange={(e) => {
              setTitle(e.target.value);
              setTitleTouched(true);
            }}
          />
        </label>
        <label className={s.field}>
          Description (optional, markdown)
          <textarea
            className={s.input}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <div className={s.field}>
          Contents
          {isWip ? (
            <div className={s.radios} role="radiogroup" aria-label="Contents">
              <label>
                <input type="radio" checked={stagedOnly} onChange={() => setStagedOnly(true)} /> Staged only
              </label>
              <label>
                <input type="radio" checked={!stagedOnly} onChange={() => setStagedOnly(false)} /> All working
                changes (incl. untracked)
              </label>
            </div>
          ) : (
            <span className={s.muted}>
              {initialSource.kind === 'commit'
                ? 'The commit, with its message and author.'
                : 'The stash, incl. untracked files.'}
            </span>
          )}
          {loadError && <p className={s.error}>{loadError}</p>}
          {!draft && !loadError && <span className={s.muted}>Reading changes…</span>}
          {draft && <FileTree files={files} selected={selected} editable={isWip} onChange={setSelected} />}
          {draft && (
            <span className={s.muted}>
              {selected.size} of {files.length} file{files.length === 1 ? '' : 's'} · base{' '}
              <code>{draft.baseSha.slice(0, 7)}</code>
              {draft.baseBranch ? ` on ${draft.baseBranch}` : ''}
            </span>
          )}
          {draft?.warnings.map((w) => (
            <p key={w} className={s.warning}>
              <TriangleAlert size={13} /> {w}
            </p>
          ))}
          {tooBig && (
            <p className={s.error}>
              These changes are too large for a Cloud Patch (limit {mb(draft.maxBytes)}). Push a branch
              instead.
            </p>
          )}
        </div>

        <div className={s.field}>
          Who can open it
          <div className={s.radios} role="radiogroup" aria-label="Visibility">
            <label>
              <input type="radio" checked={visibility === 'link'} onChange={() => changeVisibility('link')} />{' '}
              Anyone with the link
            </label>
            <label title={hasOrg ? undefined : 'Join an organization to share with its members'}>
              <input
                type="radio"
                disabled={!hasOrg}
                checked={visibility === 'org'}
                onChange={() => changeVisibility('org')}
              />{' '}
              Members of {orgName ?? 'my organization'}
            </label>
            <label title={hasOrg ? undefined : 'Join an organization to pick people'}>
              <input
                type="radio"
                disabled={!hasOrg}
                checked={visibility === 'collaborators'}
                onChange={() => changeVisibility('collaborators')}
              />{' '}
              Specific people
            </label>
          </div>
          {visibility === 'collaborators' && (
            <div className={s.people} role="group" aria-label="People">
              {members === null && <span className={s.muted}>Loading members…</span>}
              {members?.length === 0 && (
                <span className={s.muted}>No other members in this organization.</span>
              )}
              {members?.map((m) => (
                <label key={m.id} className={s.check}>
                  <input
                    type="checkbox"
                    checked={people.has(m.id)}
                    onChange={(e) => {
                      const next = new Set(people);
                      if (e.target.checked) next.add(m.id);
                      else next.delete(m.id);
                      setPeople(next);
                    }}
                  />
                  {m.name}
                  {m.email ? ` (${m.email})` : ''}
                </label>
              ))}
            </div>
          )}
        </div>

        <label className={s.field}>
          Expires
          <select
            className={s.input}
            value={expires === null ? 'never' : String(expires)}
            onChange={(e) => setExpires(e.target.value === 'never' ? null : Number(e.target.value))}
          >
            {EXPIRY.map((x) => (
              <option key={x.label} value={x.value === null ? 'never' : String(x.value)}>
                {x.label}
              </option>
            ))}
          </select>
        </label>

        <label className={s.check}>
          <input
            type="checkbox"
            checked={e2e}
            onChange={(e) => {
              setE2e(e.target.checked);
              setE2eTouched(true);
            }}
          />
          End-to-end encrypt (the key lives only in the link; the server cannot read the patch)
        </label>

        {error && <p className={s.error}>{error}</p>}
        <div className={s.buttons}>
          <button type="button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!canCreate}>
            {busy ? 'Creating…' : 'Create Cloud Patch'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** File tree with checkboxes (folders toggle all files below them). */
function FileTree({
  files,
  selected,
  editable,
  onChange,
}: {
  files: PatchFile[];
  selected: Set<string>;
  editable: boolean;
  onChange(next: Set<string>): void;
}) {
  const tree = useMemo(() => buildTree(files, (f) => f.path), [files]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const leaves = (n: TreeNode<PatchFile>): string[] =>
    n.item ? [n.item.path] : n.children.flatMap((c) => leaves(c));
  const toggle = (paths: string[], on: boolean): void => {
    const next = new Set(selected);
    for (const p of paths) {
      if (on) next.add(p);
      else next.delete(p);
    }
    onChange(next);
  };
  const render = (n: TreeNode<PatchFile>, depth: number): ReactNode => {
    const paths = leaves(n);
    const count = paths.filter((p) => selected.has(p)).length;
    const isOpen = !closed.has(n.path);
    return (
      <div key={n.path}>
        <div className={s.treeRow} style={{ paddingLeft: 6 + depth * 14 }}>
          {n.item ? (
            <span style={{ width: 14 }} />
          ) : (
            <button
              type="button"
              className={s.iconBtn}
              style={{ width: 14, height: 14 }}
              aria-label={isOpen ? 'Collapse' : 'Expand'}
              onClick={() => {
                const next = new Set(closed);
                if (isOpen) next.add(n.path);
                else next.delete(n.path);
                setClosed(next);
              }}
            >
              {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          )}
          <input
            type="checkbox"
            aria-label={n.path}
            disabled={!editable}
            checked={count === paths.length}
            ref={(el) => {
              if (el) el.indeterminate = count > 0 && count < paths.length;
            }}
            onChange={(e) => toggle(paths, e.target.checked)}
          />
          {n.item && (
            <span className={s.status} data-status={n.item.status}>
              {n.item.status}
            </span>
          )}
          <span className={s.treeName} title={n.path}>
            {n.name}
          </span>
          {n.item &&
            (n.item.binary ? (
              <span className={s.stat}>binary</span>
            ) : (
              <span className={s.stat}>
                <span className={s.add}>+{n.item.additions}</span>{' '}
                <span className={s.del}>−{n.item.deletions}</span>
              </span>
            ))}
        </div>
        {!n.item && isOpen && n.children.map((c) => render(c, depth + 1))}
      </div>
    );
  };
  return (
    <div className={s.fileTree} role="tree" aria-label="Files">
      {tree.map((n) => render(n, 0))}
    </div>
  );
}
