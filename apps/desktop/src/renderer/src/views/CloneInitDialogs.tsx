import type { ConnectedIntegration } from '@githappens/providers/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  folderFromUrl,
  hasEmbeddedCredentials,
  parseTransfer,
  type CloneTargetInfo,
  type RepoVisibility,
} from '../../../shared/ipc/repos2-contract';
import styles from '../components/Dialogs.module.css';
import { invoke, IpcError, on } from '../lib/api';
import { initialCloneDir } from '../lib/clone-dir';
import { useSetting } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useToastStore } from '../stores/toasts';
import { CloneFromProvider } from './integrations/CloneFromProvider';
import { errorText, reposInvoke } from './repos/api';
import { refreshRepos } from './repos/row-menu';
import rs from './repos/Repos.module.css';

export { folderFromUrl };

const blocked = (e: unknown): boolean => e instanceof Error && /^Blocked IPC channel/.test(e.message);

function DialogShell({
  title,
  onClose,
  onSubmitShortcut,
  children,
}: {
  title: string;
  onClose(): void;
  onSubmitShortcut?(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      style={{ width: 'min(620px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 48px)', overflow: 'auto' }}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        // Ctrl/Cmd+Enter submits (spec 03 §4.3)
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onSubmitShortcut) {
          e.preventDefault();
          onSubmitShortcut();
        }
      }}
    >
      <h2 className={styles.title}>{title}</h2>
      {children}
    </dialog>
  );
}

function FolderField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange(v: string): void;
  label: string;
}) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <input
        className={styles.input}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        aria-label="Browse…"
        title="Browse…"
        onClick={() => void invoke('repos:pickFolder', {}).then((d) => d && onChange(d))}
      >
        <FolderOpen size={15} />
      </button>
    </div>
  );
}

/** Full target path preview (spec 03 §4.3): red when the folder exists and is not empty. */
function useTarget(parentDir: string, name: string): CloneTargetInfo | null {
  const key = `${parentDir.trim()}\0${name.trim()}`;
  const [state, setState] = useState<{ key: string; info: CloneTargetInfo | null } | null>(null);
  useEffect(() => {
    if (!parentDir.trim() || !name.trim()) return;
    let live = true;
    const t = setTimeout(() => {
      reposInvoke('repos:inspectTarget', { parentDir: parentDir.trim(), folderName: name.trim() })
        .then((info) => live && setState({ key, info }))
        .catch(() => live && setState({ key, info: null }));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [parentDir, name, key]);
  return state?.key === key ? state.info : null;
}

function TargetPreview({ info, mode }: { info: CloneTargetInfo | null; mode: 'clone' | 'init' }) {
  if (!info) return null;
  const blocking = mode === 'clone' && info.exists && !info.empty;
  return (
    <div>
      <div className={`${rs.pathPreview} ${blocking ? rs.pathBad : ''}`} title={info.path}>
        {info.path}
      </div>
      {blocking && <div className={rs.pathBad}>This folder already exists and is not empty.</div>}
      {mode === 'init' && info.exists && !info.empty && (
        <div className={rs.pathWarn}>
          The folder exists; existing files are kept (README/.gitignore/LICENSE are not overwritten).
        </div>
      )}
      {info.insideRepo && (
        <div className={rs.pathWarn}>
          Inside another repository ({info.insideRepo}) — consider a submodule instead.
        </div>
      )}
    </div>
  );
}

const saveParentDir = (dir: string): void => {
  try {
    localStorage.setItem('clone:parentDir', dir);
  } catch {
    /* storage unavailable */
  }
};

interface Busy {
  opId: string;
  phase: string;
  overall: number | null;
  transferred?: string;
  speed?: string;
}

export function CloneDialog({ onClose }: { onClose(): void }) {
  const qc = useQueryClient();
  const openRepo = useTabsStore((s) => s.openRepo);
  const [url, setUrl] = useState('');
  const [parentDir, setParentDir] = useState(initialCloneDir);
  const [folder, setFolder] = useState('');
  const [folderTouched, setFolderTouched] = useState(false);
  const [recurse, setRecurse] = useState(true);
  const [openAfter, setOpenAfter] = useState(true);
  const [bare, setBare] = useState(false);
  const [shallow, setShallow] = useState(false);
  const [depth, setDepth] = useState('1');
  const [since, setSince] = useState('');
  const [branch, setBranch] = useState('');
  const [singleBranch, setSingleBranch] = useState(true);
  const [customFlags, setCustomFlags] = useState('');
  const [sparse, setSparse] = useState(false);
  const [sparsePaths, setSparsePaths] = useState('');
  const [blobless, setBlobless] = useState(true);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      on('repos:cloneProgress', (p) =>
        setBusy((b) => {
          if (!b || b.opId !== p.opId) return b;
          const t = parseTransfer(p.text);
          return {
            ...b,
            phase: p.phase || p.text,
            overall: p.overall,
            transferred: t.transferred ?? b.transferred,
            speed: t.speed ?? (p.phase.startsWith('Receiving') ? b.speed : undefined),
          };
        }),
      ),
    [],
  );

  const name = folderTouched ? folder : folderFromUrl(url);
  const target = useTarget(parentDir, name);
  const blockedTarget = !!target && target.exists && !target.empty;
  const creds = hasEmbeddedCredentials(url);
  const canClone = !!url.trim() && !!parentDir.trim() && !!name.trim() && !busy && !blockedTarget;

  const clone = async (): Promise<void> => {
    if (!canClone) return;
    const opId = crypto.randomUUID();
    setError(null);
    setBusy({ opId, phase: 'Starting…', overall: 0 });
    saveParentDir(parentDir.trim());
    const paths = sparsePaths
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const req = {
      opId,
      url: url.trim(),
      parentDir: parentDir.trim(),
      folderName: name.trim(),
      recurseSubmodules: recurse,
      bare,
      ...(shallow
        ? {
            shallow: {
              ...(Number(depth) > 0 ? { depth: Number(depth) } : {}),
              ...(since ? { sinceDate: since } : {}),
              ...(branch.trim() ? { branch: branch.trim(), singleBranch } : {}),
              ...(customFlags.trim() ? { customFlags: customFlags.trim() } : {}),
            },
          }
        : {}),
      ...(sparse && paths.length && !bare ? { sparse: { paths, blobless } } : {}),
    };
    try {
      let path: string;
      try {
        const r = await reposInvoke('repos:clone2', req);
        path = r.path;
        const notes = [
          ...(r.warnings ?? []),
          ...(r.strippedCredentials
            ? ['The credentials in the URL were removed from the saved remote.']
            : []),
          ...(r.lfs === 'pulled' ? ['Git LFS objects downloaded.'] : []),
        ];
        if (notes.length)
          useToastStore.getState().push({
            kind: r.warnings?.length ? 'warning' : 'info',
            title: 'Clone finished',
            body: notes.join(' '),
          });
      } catch (e) {
        if (!blocked(e)) throw e;
        // Main without repos:clone2: the original channel (depth / branch / submodules only).
        path = (
          await invoke('repos:clone', {
            opId,
            url: req.url,
            parentDir: req.parentDir,
            folderName: req.folderName,
            recurseSubmodules: recurse,
            ...(req.shallow?.depth ? { depth: req.shallow.depth } : {}),
            ...(req.shallow?.branch ? { branch: req.shallow.branch } : {}),
          })
        ).path;
      }
      if (openAfter && !bare) await openRepo(path);
      refreshRepos(qc);
      onClose();
    } catch (e) {
      if (!(e instanceof IpcError && e.code === 'Cancelled')) setError(errorText(e));
      setBusy(null);
    }
  };

  const cancel = (opId: string): void =>
    void reposInvoke('repos:cancel2', { opId }).catch(() => invoke('repos:cancel', { opId }));

  return (
    <DialogShell
      title="Clone a repository"
      onClose={() => (busy ? undefined : onClose())}
      onSubmitShortcut={() => void clone()}
    >
      <form
        className={styles.body}
        onSubmit={(e) => {
          e.preventDefault();
          void clone();
        }}
      >
        <label className={styles.label}>Repository URL</label>
        <input
          className={styles.input}
          autoFocus
          aria-label="Repository URL"
          placeholder="https://github.com/owner/repo.git or git@host:owner/repo.git"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={!!busy}
        />
        {creds && (
          <div className={rs.pathWarn} role="note">
            This URL contains credentials. They are used for this clone only and removed from the saved
            remote.
          </div>
        )}
        {!busy && (
          <details>
            <summary className={styles.label}>Browse connected accounts</summary>
            <CloneFromProvider
              onPick={(pickedUrl, repoName) => {
                setUrl(pickedUrl);
                if (!folderTouched) setFolder(repoName);
              }}
            />
          </details>
        )}
        <label className={styles.label}>Where to clone to</label>
        <FolderField label="Parent folder" value={parentDir} onChange={setParentDir} />
        <label className={styles.label}>Folder name</label>
        <input
          className={styles.input}
          aria-label="Folder name"
          value={name}
          onChange={(e) => {
            setFolder(e.target.value);
            setFolderTouched(true);
          }}
          disabled={!!busy}
        />
        <TargetPreview info={target} mode="clone" />

        <div className={rs.row2}>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={recurse}
              onChange={(e) => setRecurse(e.target.checked)}
              disabled={!!busy}
            />
            Recurse submodules
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={openAfter && !bare}
              onChange={(e) => setOpenAfter(e.target.checked)}
              disabled={!!busy || bare}
            />
            Open after clone
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={shallow}
              onChange={(e) => setShallow(e.target.checked)}
              disabled={!!busy}
            />
            Shallow clone
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={sparse}
              onChange={(e) => setSparse(e.target.checked)}
              disabled={!!busy || bare}
            />
            Sparse checkout
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={bare}
              onChange={(e) => setBare(e.target.checked)}
              disabled={!!busy}
            />
            Bare repository
          </label>
        </div>

        {shallow && (
          <fieldset className={rs.fieldset} disabled={!!busy}>
            <legend>Shallow clone</legend>
            <div className={rs.row2}>
              <label className={styles.label}>
                Depth
                <input
                  className={styles.input}
                  aria-label="Clone depth"
                  inputMode="numeric"
                  placeholder="Full history"
                  value={depth}
                  onChange={(e) => setDepth(e.target.value.replace(/\D/g, ''))}
                />
              </label>
              <label className={styles.label}>
                Since date
                <input
                  className={styles.input}
                  type="date"
                  aria-label="Shallow since"
                  value={since}
                  onChange={(e) => setSince(e.target.value)}
                />
              </label>
              <label className={styles.label}>
                Branch
                <input
                  className={styles.input}
                  aria-label="Clone branch"
                  placeholder="Default branch"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                />
              </label>
              <label className={styles.check} style={{ alignSelf: 'end' }}>
                <input
                  type="checkbox"
                  checked={singleBranch}
                  onChange={(e) => setSingleBranch(e.target.checked)}
                  disabled={!branch.trim()}
                />
                Single branch only
              </label>
            </div>
            <label className={styles.label}>
              Custom flags
              <input
                className={styles.input}
                aria-label="Custom clone flags"
                placeholder="--no-tags --jobs=4"
                value={customFlags}
                onChange={(e) => setCustomFlags(e.target.value)}
              />
            </label>
            <span className={styles.label}>
              Allowed: --depth, --shallow-since, --shallow-exclude, --single-branch, --no-single-branch,
              --no-tags, --filter, --origin, --jobs, --reference, --dissociate
            </span>
          </fieldset>
        )}
        {sparse && !bare && (
          <fieldset className={rs.fieldset} disabled={!!busy}>
            <legend>Sparse checkout</legend>
            <textarea
              className={styles.input}
              aria-label="Sparse paths"
              rows={4}
              placeholder={'One path per line, e.g.\nsrc/app\ndocs'}
              value={sparsePaths}
              onChange={(e) => setSparsePaths(e.target.value)}
            />
            <label className={styles.check}>
              <input type="checkbox" checked={blobless} onChange={(e) => setBlobless(e.target.checked)} />
              Blobless clone (download file contents on demand)
            </label>
          </fieldset>
        )}

        {busy && (
          <div role="status">
            <div className={rs.progressText}>
              <span>{busy.phase}</span>
              <span>
                {typeof busy.overall === 'number' ? `${Math.round(busy.overall * 100)}%` : ''}
                {busy.transferred ? ` · ${busy.transferred}` : ''}
                {busy.speed ? ` · ${busy.speed}` : ''}
              </span>
            </div>
            <progress
              value={busy.overall ?? undefined}
              max={1}
              style={{ width: '100%', display: 'block', marginTop: 4 }}
            />
          </div>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.buttons}>
          {busy ? (
            <button type="button" onClick={() => cancel(busy.opId)}>
              Cancel clone
            </button>
          ) : (
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          )}
          <button type="submit" className="primary" disabled={!canClone}>
            {busy ? 'Cloning…' : 'Clone'}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

const CREATE_KINDS = new Set(['github', 'gitlab', 'bitbucket', 'bitbucket-dc']);

function GitignorePicker({ value, onChange }: { value: string[]; onChange(v: string[]): void }) {
  const list = useQuery({
    queryKey: ['templates:gitignore:list'],
    queryFn: () => reposInvoke('templates:gitignore:list', {}).catch(() => [] as string[]),
    staleTime: Infinity,
  });
  const [text, setText] = useState('');
  const options = (list.data ?? []).filter((n) => !value.includes(n));
  const add = (n: string): void => {
    const hit = (list.data ?? []).find((x) => x.toLowerCase() === n.trim().toLowerCase());
    if (hit && !value.includes(hit)) onChange([...value, hit]);
    setText('');
  };
  return (
    <>
      <div className={rs.chips}>
        {value.map((n) => (
          <span key={n} className={rs.chip}>
            {n}
            <button
              type="button"
              aria-label={`Remove ${n}`}
              onClick={() => onChange(value.filter((x) => x !== n))}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <input
        className={styles.input}
        aria-label=".gitignore templates"
        list="kl-gitignore-templates"
        placeholder={
          list.data?.length ? 'Type to add a template (Node, Python, macOS…)' : 'No templates available'
        }
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          if ((list.data ?? []).some((x) => x === v)) add(v);
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim()) {
            e.preventDefault();
            add(text);
          }
        }}
      />
      <datalist id="kl-gitignore-templates">
        {options.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </>
  );
}

export function InitDialog({ onClose }: { onClose(): void }) {
  const qc = useQueryClient();
  const openRepo = useTabsStore((s) => s.openRepo);
  const defaultBranch = useSetting('general.defaultBranchName') ?? 'main';
  const [target, setTarget] = useState<string>('local');
  const [name, setName] = useState('');
  const [parentDir, setParentDir] = useState(initialCloneDir);
  const [branch, setBranch] = useState(defaultBranch);
  const [templates, setTemplates] = useState<string[]>([]);
  const [license, setLicense] = useState('');
  const [author, setAuthor] = useState('');
  const [readme, setReadme] = useState(true);
  const [initialCommit, setInitialCommit] = useState(true);
  const [bare, setBare] = useState(false);
  const [owner, setOwner] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<RepoVisibility>('private');
  const [protocol, setProtocol] = useState<'https' | 'ssh'>('https');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accounts = useQuery({
    queryKey: ['auth:list'],
    queryFn: () => invoke('auth:list', {}).catch(() => [] as ConnectedIntegration[]),
    staleTime: 60_000,
  });
  const creatable = useMemo(
    () => (accounts.data ?? []).filter((a) => CREATE_KINDS.has(a.kind)),
    [accounts.data],
  );
  const account = creatable.find((a) => a.key === target);
  const owners = useQuery({
    queryKey: ['provider:listOwners', account?.key],
    queryFn: () => invoke('provider:listOwners', { integrationKey: account!.key }),
    enabled: !!account,
    staleTime: 300_000,
  });
  const licenses = useQuery({
    queryKey: ['templates:license:list'],
    queryFn: () =>
      reposInvoke('templates:license:list', {}).catch(() => [] as { spdxId: string; name: string }[]),
    staleTime: Infinity,
  });
  const info = useTarget(parentDir, name);
  const remote = !!account;
  const valid =
    !!name.trim() &&
    !!parentDir.trim() &&
    !busy &&
    (!remote || (initialCommit && !bare)) &&
    (!license || !!author.trim());

  const init = async (): Promise<void> => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    saveParentDir(parentDir.trim());
    try {
      let path: string;
      try {
        const r = await reposInvoke('repos:init2', {
          parentDir: parentDir.trim(),
          name: name.trim(),
          defaultBranch: branch.trim() || 'main',
          gitignoreTemplates: bare ? [] : templates,
          ...(license && !bare
            ? { license: { spdxId: license, author: author.trim(), year: new Date().getFullYear() } }
            : {}),
          createReadme: readme && !bare,
          initialCommit: initialCommit && !bare,
          bare,
          ...(account
            ? {
                remote: {
                  integrationKey: account.key,
                  ...(owner ? { owner } : {}),
                  name: name.trim(),
                  description: description.trim(),
                  visibility,
                  protocol,
                },
                opId: crypto.randomUUID(),
              }
            : {}),
        });
        path = r.path;
        if (r.remote && r.pushError) {
          useToastStore.getState().push({
            kind: 'error',
            title: `Created ${r.remote.fullName}, but the push failed`,
            body: `${r.pushError} — push from the toolbar once the problem is fixed.`,
          });
        } else if (r.remote) {
          useToastStore
            .getState()
            .push({ kind: 'success', title: `Published to ${r.remote.fullName}`, body: r.remote.webUrl });
        }
      } catch (e) {
        if (!blocked(e) || account || license || templates.length || bare) throw e;
        path = (
          await invoke('repos:init', {
            parentDir: parentDir.trim(),
            name: name.trim(),
            defaultBranch: branch.trim() || 'main',
            readme,
            initialCommit,
          })
        ).path;
      }
      if (!bare) await openRepo(path);
      refreshRepos(qc);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <DialogShell title="Initialize a repository" onClose={onClose} onSubmitShortcut={() => void init()}>
      <form
        className={styles.body}
        onSubmit={(e) => {
          e.preventDefault();
          void init();
        }}
      >
        <div className={rs.tabs} role="tablist" aria-label="Where to create">
          <button
            type="button"
            role="tab"
            aria-selected={target === 'local'}
            className={`${rs.tab} ${target === 'local' ? rs.tabActive : ''}`}
            onClick={() => setTarget('local')}
          >
            Local only
          </button>
          {creatable.map((a) => (
            <button
              key={a.key}
              type="button"
              role="tab"
              aria-selected={target === a.key}
              className={`${rs.tab} ${target === a.key ? rs.tabActive : ''}`}
              onClick={() => {
                setTarget(a.key);
                setBare(false);
                setInitialCommit(true);
                setOwner('');
              }}
            >
              {a.kind} · {a.login}
            </button>
          ))}
        </div>
        <label className={styles.label}>Name</label>
        <input
          className={styles.input}
          autoFocus
          aria-label="Repository name"
          placeholder="my-project"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className={styles.label}>Create in</label>
        <FolderField label="Parent folder" value={parentDir} onChange={setParentDir} />
        <TargetPreview info={info} mode="init" />
        <label className={styles.label}>Default branch</label>
        <input
          className={styles.input}
          aria-label="Default branch"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        />

        {remote && (
          <fieldset className={rs.fieldset}>
            <legend>Remote repository</legend>
            <div className={rs.row2}>
              <label className={styles.label}>
                Owner
                <select aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
                  <option value="">{account?.login} (you)</option>
                  {(owners.data ?? [])
                    .filter((o) => o.login !== account?.login)
                    .map((o) => (
                      <option key={o.login} value={o.login}>
                        {o.login}
                      </option>
                    ))}
                </select>
              </label>
              <label className={styles.label}>
                Visibility
                <select
                  aria-label="Visibility"
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value as RepoVisibility)}
                >
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
              </label>
            </div>
            <input
              className={styles.input}
              aria-label="Description"
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <label className={styles.label}>
              Remote URL
              <select
                aria-label="Remote protocol"
                value={protocol}
                onChange={(e) => setProtocol(e.target.value as 'https' | 'ssh')}
              >
                <option value="https">HTTPS</option>
                <option value="ssh">SSH</option>
              </select>
            </label>
          </fieldset>
        )}

        {!bare && (
          <>
            <label className={styles.label}>.gitignore templates</label>
            <GitignorePicker value={templates} onChange={setTemplates} />
            <div className={rs.row2}>
              <label className={styles.label}>
                License
                <select aria-label="License" value={license} onChange={(e) => setLicense(e.target.value)}>
                  <option value="">None</option>
                  {(licenses.data ?? []).map((l) => (
                    <option key={l.spdxId} value={l.spdxId}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
              {license && (
                <label className={styles.label}>
                  Copyright holder
                  <input
                    className={styles.input}
                    aria-label="Copyright holder"
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                  />
                </label>
              )}
            </div>
            <label className={styles.check}>
              <input type="checkbox" checked={readme} onChange={(e) => setReadme(e.target.checked)} /> Add a
              README.md
            </label>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={initialCommit}
                disabled={remote}
                onChange={(e) => setInitialCommit(e.target.checked)}
              />{' '}
              Make an initial commit
            </label>
          </>
        )}
        {!remote && (
          <label className={styles.check}>
            <input type="checkbox" checked={bare} onChange={(e) => setBare(e.target.checked)} /> Bare
            repository (no working tree)
          </label>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.buttons}>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            {busy ? 'Creating…' : remote ? 'Create and publish' : 'Create repository'}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
