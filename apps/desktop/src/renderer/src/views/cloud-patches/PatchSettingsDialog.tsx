import { createElement, useEffect, useRef, useState } from 'react';

import type {
  CloudPatch,
  PatchAvailability,
  PatchVisibility,
  UserRef,
} from '../../../../shared/ipc/patches-contract';
import { mountDialog } from '../../ai/mount';
import { errorText, patchInvoke } from '../../cloud-patches/api';
import { useToastStore } from '../../stores/toasts';
import s from './CloudPatches.module.css';

const EXPIRY = [
  { value: '', label: 'Keep current' },
  { value: '7', label: '7 days from now' },
  { value: '30', label: '30 days from now' },
  { value: '90', label: '90 days from now' },
  { value: 'never', label: 'Never' },
];

/** Edit visibility / collaborators / expiry of one of my Cloud Patches. */
export function openPatchSettings(patch: CloudPatch, avail: PatchAvailability): Promise<void> {
  return mountDialog<void>((done) =>
    createElement(PatchSettingsDialog, { patch, avail, onClose: () => done() }),
  );
}

function PatchSettingsDialog({
  patch,
  avail,
  onClose,
}: {
  patch: CloudPatch;
  avail: PatchAvailability;
  onClose(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [visibility, setVisibility] = useState<PatchVisibility>(patch.visibility);
  const [people, setPeople] = useState<Set<string>>(new Set((patch.collaborators ?? []).map((u) => u.id)));
  const [members, setMembers] = useState<UserRef[] | null>(null);
  const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasOrg = !!patch.orgId || avail.orgs.length > 0;

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    if (visibility !== 'collaborators' || members) return;
    patchInvoke('patch:collaboratorCandidates', patch.orgId ? { orgId: patch.orgId } : {}).then(
      (r) => setMembers(r.members),
      (e: unknown) => {
        setMembers([]);
        setError(errorText(e));
      },
    );
  }, [visibility, members, patch.orgId]);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await patchInvoke('patch:update', {
        id: patch.id,
        visibility,
        ...(visibility === 'collaborators' ? { collaborators: [...people] } : {}),
        ...(expiry ? { expiresInDays: expiry === 'never' ? null : Number(expiry) } : {}),
      });
      useToastStore.getState().push({ kind: 'success', title: 'Cloud Patch updated' });
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-label="Edit Cloud Patch visibility"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 className={s.dialogTitle}>Edit visibility</h2>
      <div className={s.dialogBody}>
        <span className={s.muted}>{patch.localTitle ?? patch.title}</span>
        <div className={s.radios} role="radiogroup" aria-label="Visibility">
          <label>
            <input type="radio" checked={visibility === 'link'} onChange={() => setVisibility('link')} />{' '}
            Anyone with the link
          </label>
          <label>
            <input
              type="radio"
              disabled={!hasOrg}
              checked={visibility === 'org'}
              onChange={() => setVisibility('org')}
            />{' '}
            Organization members
          </label>
          <label>
            <input
              type="radio"
              disabled={!hasOrg}
              checked={visibility === 'collaborators'}
              onChange={() => setVisibility('collaborators')}
            />{' '}
            Specific people
          </label>
        </div>
        {visibility === 'collaborators' && (
          <div className={s.people} role="group" aria-label="People">
            {members === null && <span className={s.muted}>Loading members…</span>}
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
              </label>
            ))}
          </div>
        )}
        <label className={s.field}>
          Expires
          <select className={s.input} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            {EXPIRY.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        {error && <p className={s.error}>{error}</p>}
        <div className={s.buttons}>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || (visibility === 'collaborators' && people.size === 0)}
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      </div>
    </dialog>
  );
}
