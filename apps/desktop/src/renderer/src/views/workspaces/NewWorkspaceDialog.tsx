import type { RemoteRepo } from '@githappens/providers/types';
import { useQuery } from '@tanstack/react-query';
import { Cloud, FileCode, FolderOpen, FolderSearch, FolderSync, Layers, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { NewWorkspaceRepo, WorkspaceKind } from '../../../../shared/ipc/workspaces-contract';
import dialogStyles from '../../components/Dialogs.module.css';
import { providerLabel } from '../../integrations/helpers';
import { useIntegrations, useOwners, useRemoteRepos } from '../../integrations/queries';
import { invoke } from '../../lib/api';
import { initialCloneDir } from '../../lib/clone-dir';
import { fuzzyMatch } from '../../lib/format';
import { useSetting } from '../../stores/settings';
import { errorMessage, wsInvoke } from '../../workspaces/api';
import { importCodeWorkspace, importWorkspaceJson } from '../../workspaces/actions';
import { useWorkspaceUi } from '../../workspaces/queries';
import s from './Workspaces.module.css';

type Step = 'kind' | 'local' | 'directory' | 'provider';

/** Theme-aware swatches (stored as CSS color strings). */
export const WORKSPACE_COLORS = [
  'var(--kl-blue)',
  'var(--kl-green)',
  'var(--kl-yellow)',
  'var(--kl-orange)',
  'var(--kl-red)',
  'var(--kl-purple)',
  'var(--kl-teal)',
];

const HOSTING = new Set(['github', 'gitlab', 'bitbucket', 'bitbucket-dc', 'azure-devops']);
const DEFAULT_IGNORE = 'node_modules, .git/modules';

interface Candidate {
  path: string;
  name: string;
  checked: boolean;
  source: 'recent' | 'folder' | 'scan';
}

function Shell({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={dialogStyles.dialog}
      style={{ width: 'min(640px, calc(100vw - 32px))' }}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 className={dialogStyles.title}>{title}</h2>
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
    <div className={s.folderField}>
      <input
        className={dialogStyles.input}
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

function KindCard({
  icon,
  title,
  text,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  onClick(): void;
  disabled?: boolean;
}) {
  return (
    <button type="button" className={s.kindCard} onClick={onClick} disabled={disabled}>
      <span className={s.kindIcon}>{icon}</span>
      <span>
        <strong>{title}</strong>
        <span className={s.muted}>{text}</span>
      </span>
    </button>
  );
}

/** NewWorkspaceDialog (spec 11 §4.1): Local · Directory-synced · Provider repos · Import .code-workspace. */
export function NewWorkspaceDialog({ onClose }: { onClose(): void }) {
  const [step, setStep] = useState<Step>('kind');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState<string | undefined>(WORKSPACE_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const select = useWorkspaceUi((st) => st.select);

  // local
  const recents = useQuery({ queryKey: ['repos:list'], queryFn: () => invoke('repos:list', {}) });
  // Folders added / found by a scan come first; recents fill the rest (unchecked until picked).
  const [added, setAdded] = useState<Candidate[]>([]);
  const [recentChecks, setRecentChecks] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');
  const [scanDepthLocal, setScanDepthLocal] = useState(1);
  const [scanning, setScanning] = useState(false);
  const candidates = useMemo(() => {
    const have = new Set(added.map((x) => x.path.toLowerCase()));
    const fromRecents = (recents.data ?? [])
      .filter((r) => !r.missing && !r.isBare && !have.has(r.path.toLowerCase()))
      .map((r) => ({
        path: r.path,
        name: r.alias ?? r.name,
        checked: !!recentChecks[r.path],
        source: 'recent' as const,
      }));
    return [...added, ...fromRecents];
  }, [added, recents.data, recentChecks]);
  const toggleCandidate = (c: Candidate, on: boolean): void => {
    if (c.source === 'recent') setRecentChecks((m) => ({ ...m, [c.path]: on }));
    else setAdded((all) => all.map((x) => (x.path === c.path ? { ...x, checked: on } : x)));
  };

  // directory
  const defaultDepth = useSetting('workspaces.scanDepth') ?? 2;
  const [root, setRoot] = useState('');
  const [depth, setDepth] = useState<number | null>(null);
  const [includeNested, setIncludeNested] = useState(false);
  const [ignore, setIgnore] = useState(DEFAULT_IGNORE);
  const [preview, setPreview] = useState<{ names: string[]; truncated: boolean } | null>(null);

  // provider
  const integrations = useIntegrations();
  const accounts = useMemo(
    () => (integrations.data ?? []).filter((a) => HOSTING.has(a.kind)),
    [integrations.data],
  );
  const [accountKey, setAccountKey] = useState<string | null>(null);
  const account = accounts.find((a) => a.key === accountKey) ?? accounts[0];
  const [owner, setOwner] = useState('');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Map<string, RemoteRepo>>(new Map());
  const [cloneRoot, setCloneRoot] = useState(initialCloneDir);
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const owners = useOwners(step === 'provider' ? account?.key : undefined);
  const remote = useRemoteRepos(step === 'provider' ? account?.key : undefined, owner, query);
  const remoteItems = useMemo(() => remote.data?.pages.flatMap((p) => p.items) ?? [], [remote.data]);

  const ignoreList = (): string[] =>
    ignore
      .split(/[,\n]/)
      .map((g) => g.trim())
      .filter(Boolean);

  const addFolder = async (): Promise<void> => {
    const dir = await invoke('repos:pickFolder', {});
    if (!dir) return;
    setAdded((c) => [
      { path: dir, name: dir.split(/[\\/]/).pop() ?? dir, checked: true, source: 'folder' },
      ...c.filter((x) => x.path.toLowerCase() !== dir.toLowerCase()),
    ]);
  };

  const scanFolder = async (): Promise<void> => {
    const dir = await invoke('repos:pickFolder', {});
    if (!dir) return;
    setScanning(true);
    setError(null);
    try {
      const r = await wsInvoke('workspace:scanDirectory', { root: dir, depth: scanDepthLocal });
      setAdded((c) => {
        const found = new Set(r.repos.map((x) => x.path.toLowerCase()));
        return [
          ...r.repos.map((x) => ({ path: x.path, name: x.name, checked: true, source: 'scan' as const })),
          ...c.filter((x) => !found.has(x.path.toLowerCase())),
        ];
      });
      if (!r.repos.length) setError(`No repositories found under ${dir}.`);
      else if (r.truncated) setError(`Showing the first ${r.repos.length} repositories only.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setScanning(false);
    }
  };

  const previewScan = async (): Promise<void> => {
    if (!root.trim()) return;
    setScanning(true);
    setError(null);
    try {
      const r = await wsInvoke('workspace:scanDirectory', {
        root: root.trim(),
        depth: depth ?? defaultDepth,
        ignore: ignoreList(),
        includeNested,
      });
      setPreview({ names: r.repos.map((x) => x.name), truncated: r.truncated });
      if (!name.trim()) setName(root.trim().split(/[\\/]/).filter(Boolean).pop() ?? '');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setScanning(false);
    }
  };

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const base = { name: name.trim(), description: description.trim() || undefined, color };
      let kind: WorkspaceKind = 'local';
      let repos: NewWorkspaceRepo[] = [];
      let extra = {};
      if (step === 'local') {
        repos = candidates.filter((c) => c.checked).map((c) => ({ localPath: c.path, name: c.name }));
      } else if (step === 'directory') {
        kind = 'directory';
        extra = {
          directory: { root: root.trim(), depth: depth ?? defaultDepth, includeNested, ignore: ignoreList() },
        };
      } else if (step === 'provider') {
        kind = 'cloud';
        repos = [...picked.values()].map((r) => ({
          name: r.ref.name,
          provider: {
            integrationKey: account!.key,
            owner: r.ref.owner,
            name: r.ref.name,
            cloneUrlHttps: r.httpsUrl,
            cloneUrlSsh: r.sshUrl,
            webUrl: r.webUrl,
          },
          remoteUrl: r.httpsUrl,
        }));
        if (cloneRoot.trim()) extra = { defaultCloneRoot: cloneRoot.trim() };
      }
      const ws = await wsInvoke('workspace:create', { kind, ...base, repos, ...extra });
      select(ws.id);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const shown = candidates.filter((c) => !filter || fuzzyMatch(`${c.name} ${c.path}`, filter) !== null);
  const checkedCount = candidates.filter((c) => c.checked).length;
  const canCreate =
    !busy &&
    !!name.trim() &&
    (step !== 'directory' || !!root.trim()) &&
    (step !== 'provider' || (!!account && picked.size > 0));

  if (step === 'kind') {
    return (
      <Shell title="New workspace" onClose={onClose}>
        <div className={dialogStyles.body}>
          <KindCard
            icon={<Layers size={20} />}
            title="Local workspace"
            text="Pick repositories on this machine, or scan a folder for them."
            onClick={() => setStep('local')}
          />
          <KindCard
            icon={<FolderSync size={20} />}
            title="Directory-synced"
            text="Always contains every repository under a folder."
            onClick={() => setStep('directory')}
          />
          <KindCard
            icon={<Cloud size={20} />}
            title="Provider repositories"
            text="Pick repositories from a connected GitHub, GitLab, Bitbucket or Azure DevOps account; clone missing ones in one step."
            onClick={() => setStep('provider')}
          />
          <KindCard
            icon={<FileCode size={20} />}
            title="Import .code-workspace"
            text="Create a workspace from the git repositories of a VS Code workspace file."
            onClick={() => void importCodeWorkspace().then((ws) => ws && onClose())}
          />
          <div className={dialogStyles.buttons}>
            <button
              type="button"
              className={s.linkBtn}
              onClick={() => void importWorkspaceJson().then(onClose)}
            >
              Import workspace JSON…
            </button>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  const title =
    step === 'local'
      ? 'New local workspace'
      : step === 'directory'
        ? 'New directory-synced workspace'
        : 'New provider workspace';

  return (
    <Shell title={title} onClose={() => (busy ? undefined : onClose())}>
      <form
        className={dialogStyles.body}
        onSubmit={(e) => {
          e.preventDefault();
          if (canCreate) void create();
        }}
      >
        <label className={dialogStyles.label}>Name</label>
        <div className={s.nameRow}>
          <input
            className={dialogStyles.input}
            autoFocus
            aria-label="Workspace name"
            placeholder="Payments"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className={s.colors} role="radiogroup" aria-label="Color">
            {WORKSPACE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={c.replace(/^var\(--kl-|\)$/g, '')}
                className={`${s.colorDot} ${color === c ? s.colorOn : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>
        <label className={dialogStyles.label}>Description (optional)</label>
        <input
          className={dialogStyles.input}
          aria-label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        {step === 'local' && (
          <>
            <div className={s.pickerBar}>
              <label className={dialogStyles.label}>Repositories ({checkedCount} selected)</label>
              <span style={{ flex: 1 }} />
              <button type="button" onClick={() => void addFolder()}>
                <Plus size={14} /> Add folder…
              </button>
              <select
                aria-label="Scan depth"
                value={scanDepthLocal}
                onChange={(e) => setScanDepthLocal(Number(e.target.value))}
                title="Scan depth"
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    depth {n}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => void scanFolder()} disabled={scanning}>
                <FolderSearch size={14} /> {scanning ? 'Scanning…' : 'Scan folder…'}
              </button>
            </div>
            <input
              className={dialogStyles.input}
              placeholder="Filter…"
              aria-label="Filter repositories"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <ul className={s.pickList} aria-label="Repositories to add">
              {shown.length === 0 && <li className={s.muted}>No repositories yet — add or scan a folder.</li>}
              {shown.map((c) => (
                <li key={c.path}>
                  <label className={s.pickRow}>
                    <input
                      type="checkbox"
                      checked={c.checked}
                      onChange={(e) => toggleCandidate(c, e.target.checked)}
                    />
                    <span className={s.pickName}>{c.name}</span>
                    <span className={s.pickPath}>{c.path}</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}

        {step === 'directory' && (
          <>
            <label className={dialogStyles.label}>Root folder</label>
            <FolderField
              label="Root folder"
              value={root}
              onChange={(v) => {
                setRoot(v);
                setPreview(null);
              }}
            />
            <div className={s.pickerBar}>
              <label className={dialogStyles.label}>
                Scan depth{' '}
                <select
                  aria-label="Scan depth"
                  value={depth ?? defaultDepth}
                  onChange={(e) => {
                    setDepth(Number(e.target.value));
                    setPreview(null);
                  }}
                >
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label className={dialogStyles.check}>
                <input
                  type="checkbox"
                  checked={includeNested}
                  onChange={(e) => setIncludeNested(e.target.checked)}
                />
                Include nested repositories
              </label>
            </div>
            <label className={dialogStyles.label}>Ignore (comma-separated globs)</label>
            <input
              className={dialogStyles.input}
              aria-label="Ignore globs"
              value={ignore}
              onChange={(e) => setIgnore(e.target.value)}
            />
            <div className={s.pickerBar}>
              <button type="button" onClick={() => void previewScan()} disabled={!root.trim() || scanning}>
                <FolderSearch size={14} /> {scanning ? 'Scanning…' : 'Preview'}
              </button>
              {preview && (
                <span className={s.muted}>
                  {preview.names.length} repositories
                  {preview.truncated ? ' (capped)' : ''}
                  {preview.names.length
                    ? `: ${preview.names.slice(0, 8).join(', ')}${preview.names.length > 8 ? '…' : ''}`
                    : ''}
                </span>
              )}
            </div>
          </>
        )}

        {step === 'provider' && (
          <>
            {integrations.isPending ? (
              <p className={s.muted}>Loading accounts…</p>
            ) : !account ? (
              <p className={s.muted}>
                Connect a GitHub, GitLab, Bitbucket or Azure DevOps account in Preferences → Integrations
                first.
              </p>
            ) : (
              <>
                <div className={s.pickerBar}>
                  {accounts.length > 1 && (
                    <select
                      aria-label="Account"
                      value={account.key}
                      onChange={(e) => {
                        setAccountKey(e.target.value);
                        setOwner('');
                        setPicked(new Map());
                      }}
                    >
                      {accounts.map((a) => (
                        <option key={a.key} value={a.key}>
                          {a.login} · {providerLabel(a.kind)}
                        </option>
                      ))}
                    </select>
                  )}
                  <select aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
                    <option value="">All owners</option>
                    {(owners.data ?? []).map((o) => (
                      <option key={o.login} value={o.login}>
                        {o.login}
                      </option>
                    ))}
                  </select>
                  <input
                    className={dialogStyles.input}
                    style={{ flex: 1, width: 'auto' }}
                    placeholder="Search repositories"
                    aria-label="Search repositories"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                </div>
                <ul className={s.pickList} aria-label="Provider repositories">
                  {remote.isPending && <li className={s.muted}>Loading repositories…</li>}
                  {remote.error ? <li className={dialogStyles.error}>{errorMessage(remote.error)}</li> : null}
                  {remoteItems.map((r) => (
                    <li key={r.fullName}>
                      <label className={s.pickRow}>
                        <input
                          type="checkbox"
                          checked={picked.has(r.fullName)}
                          onChange={(e) =>
                            setPicked((m) => {
                              const next = new Map(m);
                              if (e.target.checked) next.set(r.fullName, r);
                              else next.delete(r.fullName);
                              return next;
                            })
                          }
                        />
                        <span className={s.pickName}>{r.fullName}</span>
                        <span className={s.pickPath}>{r.description}</span>
                      </label>
                    </li>
                  ))}
                  {remote.hasNextPage && (
                    <li>
                      <button type="button" className={s.linkBtn} onClick={() => void remote.fetchNextPage()}>
                        Load more…
                      </button>
                    </li>
                  )}
                </ul>
                <span className={s.muted}>{picked.size} selected</span>
                <label className={dialogStyles.label}>Clone missing repositories into</label>
                <FolderField label="Clone folder" value={cloneRoot} onChange={setCloneRoot} />
              </>
            )}
          </>
        )}

        {error && (
          <p className={dialogStyles.error} role="alert">
            {error}
          </p>
        )}
        <div className={dialogStyles.buttons}>
          <button type="button" onClick={() => setStep('kind')} disabled={busy}>
            Back
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!canCreate}>
            {busy ? 'Creating…' : 'Create workspace'}
          </button>
        </div>
      </form>
    </Shell>
  );
}
