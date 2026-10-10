import { Cloud, Share2 } from 'lucide-react';
import { createElement, useCallback, useEffect, useRef, useState } from 'react';

import type {
  CloudWorkspaceInfo,
  CloudWorkspaceLinkStatus,
  ShareTargets,
  WorkspaceShare,
} from '../../../../shared/ipc/cloud-workspaces-contract';
import { mountDialog } from '../../ai/mount';
import { errorText, extrasInvoke } from '../../cloud/extras-api';
import { invoke } from '../../lib/api';
import { useToastStore } from '../../stores/toasts';
import s from '../suggest/Suggest.module.css';

const toast = (kind: 'success' | 'error' | 'info', title: string, body?: string): void =>
  void useToastStore.getState().push({ kind, title, ...(body ? { body } : {}) });

// ---- Share / Convert to cloud ------------------------------------------------------------------

/**
 * "Share…" / "Convert to cloud" for the WorkspaceView header (spec 14 §4.6): publishes the workspace to
 * the cloud WITHOUT local paths and shares it with the org, teams or members.
 * Mount: `<ShareWorkspaceButton workspaceId={ws.id} />`.
 */
export function ShareWorkspaceButton({
  workspaceId,
  className,
}: {
  workspaceId: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => void openShareWorkspace(workspaceId)}
      title="Share this workspace with your organization (repository names and remote URLs only)"
    >
      <Share2 size={14} /> Share…
    </button>
  );
}

export function openShareWorkspace(workspaceId: string): Promise<void> {
  return mountDialog<void>((done) => createElement(ShareDialog, { workspaceId, onClose: () => done() }));
}

function ShareDialog({ workspaceId, onClose }: { workspaceId: string; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<CloudWorkspaceLinkStatus | null>(null);
  const [targets, setTargets] = useState<ShareTargets | null>(null);
  const [shares, setShares] = useState<WorkspaceShare[]>([]);
  const [orgId, setOrgId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const st = await extrasInvoke('cloudWorkspace:status', { workspaceId });
      setStatus(st);
      if (st.linked) setShares(st.linked.shares);
    } catch (e) {
      setError(errorText(e));
    }
  }, [workspaceId]);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    const t = setTimeout(() => void reload(), 0);
    extrasInvoke('cloudWorkspace:shareTargets', {}).then(
      (t) => {
        setTargets(t);
        setOrgId((o) => o || t.orgs[0]?.id || '');
      },
      (e: unknown) => setError(errorText(e)),
    );
    return () => clearTimeout(t);
  }, [reload]);

  const run = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast('success', ok);
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const has = (t: WorkspaceShare['principalType'], id: string): boolean =>
    shares.some((x) => x.principalType === t && x.principalId === id);
  const toggle = (t: WorkspaceShare['principalType'], id: string, on: boolean): void =>
    setShares((prev) =>
      on
        ? [...prev, { principalType: t, principalId: id }]
        : prev.filter((x) => !(x.principalType === t && x.principalId === id)),
    );

  const linked = status?.linked ?? null;
  const scopeOrg = linked?.orgId ?? orgId;
  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-label="Share workspace"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 className={s.title}>
        <Cloud size={16} /> {linked ? `Cloud workspace “${linked.name}”` : 'Convert to cloud workspace'}
      </h2>
      <div className={s.body}>
        <p className={s.muted}>
          Only the workspace name and each repository’s name and remote URL (without credentials) are uploaded
          — never local paths. Teammates open it and clone what they are missing.
        </p>
        {!status && !error && <p className={s.muted}>Loading…</p>}
        {status && !linked && (
          <>
            {targets && targets.orgs.length > 0 && (
              <label className={s.field}>
                Organization
                <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                  {targets.orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className={s.buttons}>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      extrasInvoke('cloudWorkspace:publish', { workspaceId, ...(orgId ? { orgId } : {}) }),
                    'Workspace converted to a cloud workspace',
                  )
                }
              >
                Convert to cloud workspace
              </button>
            </div>
          </>
        )}
        {linked && (
          <>
            <p className={s.muted}>
              {linked.repos.length} repositories · version {linked.version} · updated{' '}
              {new Date(linked.updatedAt).toLocaleString()}
              {status?.missing ? ` · ${status.missing} not cloned here` : ''}
            </p>
            {status?.localChanged && (
              <p className={s.warn}>This workspace changed locally since it was published.</p>
            )}
            {status?.remoteChanged && <p className={s.warn}>The cloud copy was changed elsewhere.</p>}
            {linked.canWrite && (
              <div className={s.buttons} style={{ justifyContent: 'flex-start' }}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => extrasInvoke('cloudWorkspace:publish', { workspaceId }),
                      'Cloud copy updated',
                    )
                  }
                >
                  Update cloud copy
                </button>
                {status?.remoteChanged && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => extrasInvoke('cloudWorkspace:publish', { workspaceId, force: true }),
                        'Cloud copy overwritten',
                      )
                    }
                  >
                    Overwrite cloud copy
                  </button>
                )}
              </div>
            )}
            {linked.canWrite && targets && (
              <fieldset className={s.field} style={{ border: 0, padding: 0, margin: 0 }}>
                <legend>Share with</legend>
                {targets.orgs
                  .filter((o) => !scopeOrg || o.id === scopeOrg)
                  .map((o) => (
                    <label key={o.id} className={s.check}>
                      <input
                        type="checkbox"
                        checked={has('org', o.id)}
                        onChange={(e) => toggle('org', o.id, e.target.checked)}
                      />
                      Everyone in {o.name}
                    </label>
                  ))}
                {targets.teams
                  .filter((t) => !scopeOrg || t.orgId === scopeOrg)
                  .map((t) => (
                    <label key={t.id} className={s.check}>
                      <input
                        type="checkbox"
                        checked={has('team', t.id)}
                        onChange={(e) => toggle('team', t.id, e.target.checked)}
                      />
                      Team {t.name} ({t.memberCount})
                    </label>
                  ))}
                {targets.members
                  .filter((m) => !scopeOrg || m.orgId === scopeOrg)
                  .map((m) => (
                    <label key={`${m.orgId}:${m.id}`} className={s.check}>
                      <input
                        type="checkbox"
                        checked={has('user', m.id)}
                        onChange={(e) => toggle('user', m.id, e.target.checked)}
                      />
                      {m.name}
                      {m.email ? <span className={s.muted}>{m.email}</span> : null}
                    </label>
                  ))}
                <div className={s.buttons}>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => extrasInvoke('cloudWorkspace:share', { id: linked.id, shares }),
                        'Sharing updated',
                      )
                    }
                  >
                    Save sharing
                  </button>
                </div>
              </fieldset>
            )}
            <div className={s.buttons}>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => extrasInvoke('cloudWorkspace:unlink', { workspaceId }),
                    'Stopped syncing on this computer',
                  )
                }
              >
                Unlink on this computer
              </button>
              {linked.canWrite && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm('Delete the cloud workspace for everyone it is shared with?'))
                      void run(
                        () => extrasInvoke('cloudWorkspace:delete', { id: linked.id }),
                        'Cloud workspace deleted',
                      );
                  }}
                >
                  Delete cloud workspace
                </button>
              )}
            </div>
          </>
        )}
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        <div className={s.buttons}>
          <button type="button" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}

// ---- Cloud workspaces list (shared with me) -----------------------------------------------------

/**
 * "Cloud workspaces" (shared with me / mine) with Open and Clone missing — for the workspaces sidebar.
 * Mount: `<CloudWorkspacesButton />` or call `openCloudWorkspaces()`.
 */
export function CloudWorkspacesButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => void openCloudWorkspaces()}
      title="Cloud workspaces shared with you"
    >
      <Cloud size={14} /> Cloud workspaces
    </button>
  );
}

export function openCloudWorkspaces(): Promise<void> {
  return mountDialog<void>((done) => createElement(CloudWorkspacesList, { onClose: () => done() }));
}

function CloudWorkspacesList({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<CloudWorkspaceInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    extrasInvoke('cloudWorkspace:list', {}).then(
      (r) => setItems(r.items),
      (e: unknown) => setError(errorText(e)),
    );
  }, []);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    reload();
  }, [reload]);

  const pickFolder = async (): Promise<string | null> => {
    try {
      return await invoke('repos:pickFolder', {});
    } catch {
      return null;
    }
  };

  const open = async (w: CloudWorkspaceInfo, clone: boolean): Promise<void> => {
    setBusy(w.id);
    setError(null);
    try {
      let localId = w.localWorkspaceId;
      let missing = 0;
      if (!localId || !clone) {
        const r = await extrasInvoke('cloudWorkspace:open', { id: w.id });
        localId = r.workspace.id;
        missing = r.missing.length;
        toast(
          'success',
          `Workspace “${w.name}” is available`,
          missing ? `${missing} repositories are not cloned yet.` : undefined,
        );
      }
      if (clone) {
        let res;
        try {
          res = await extrasInvoke('cloudWorkspace:cloneMissing', { workspaceId: localId });
        } catch {
          const root = await pickFolder();
          if (!root) return;
          res = await extrasInvoke('cloudWorkspace:cloneMissing', { workspaceId: localId, cloneRoot: root });
        }
        toast(
          'info',
          res.count ? `Cloning ${res.count} repositories…` : 'Every repository is already cloned',
        );
      }
      reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-label="Cloud workspaces"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 className={s.title}>
        <Cloud size={16} /> Cloud workspaces
      </h2>
      <div className={s.body}>
        {!items && !error && <p className={s.muted}>Loading…</p>}
        {items && !items.length && (
          <p className={s.muted}>No cloud workspaces yet. Use “Share…” on a workspace to convert it.</p>
        )}
        {items?.map((w) => (
          <div key={w.id} className={s.row}>
            <span className={s.rowTitle} title={w.description ?? w.name}>
              {w.name}
            </span>
            <span className={s.muted}>
              {w.repos.length} repos{w.orgName ? ` · ${w.orgName}` : ''}
              {w.mine ? '' : ' · shared with you'}
            </span>
            {w.localWorkspaceId && <span className={s.pill}>on this computer</span>}
            <button type="button" disabled={!!busy} onClick={() => void open(w, false)}>
              {w.localWorkspaceId ? 'Refresh' : 'Open'}
            </button>
            <button type="button" disabled={!!busy} onClick={() => void open(w, true)}>
              Clone missing
            </button>
          </div>
        ))}
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        <div className={s.buttons}>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
