import type { RepoId } from '@githappens/git/types';
import { useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Cloud,
  Ellipsis,
  Link2,
  Lock,
  RefreshCw,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import type { CloudPatch } from '../../../../shared/ipc/patches-contract';
import { cloudPatchCommands, openPatchLink } from '../../cloud-patches/actions';
import {
  copyText,
  errorText,
  patchInvoke,
  patchKeys,
  usePatchAvailability,
  usePatchList,
} from '../../cloud-patches/api';
import { registerCommands } from '../../commands/registry';
import { useContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { confirm } from '../../components/Dialogs';
import { formatDate } from '../../lib/format';
import { useToastStore } from '../../stores/toasts';
import leftStyles from '../left/LeftPanel.module.css';
import s from './CloudPatches.module.css';

const VIS_ICON = { link: Link2, org: Building2, collaborators: Users } as const;
const VIS_LABEL = {
  link: 'Anyone with the link',
  org: 'Organization members',
  collaborators: 'Specific people',
};

export const patchTitle = (p: CloudPatch): string => p.localTitle ?? p.title;

/** Copy a patch link; e2e links without the key (other session) can't be decrypted by recipients. */
export function copyPatchLink(p: CloudPatch): void {
  copyText(p.shareUrl);
  const t = useToastStore.getState();
  if (p.e2e && !p.hasKey) {
    t.push({
      kind: 'warning',
      title: 'Link copied without its key',
      body: 'This patch is end-to-end encrypted and its key is only in the link you shared when you created it.',
    });
  } else t.push({ kind: 'success', title: 'Cloud Patch link copied' });
}

export async function deletePatch(p: CloudPatch): Promise<boolean> {
  const ok = await confirm(
    'Delete Cloud Patch?',
    `"${patchTitle(p)}" will be deleted from the server. Its link stops working.`,
    'Delete',
    true,
  );
  if (!ok) return false;
  try {
    await patchInvoke('patch:delete', { id: p.id });
    useToastStore.getState().push({ kind: 'success', title: 'Cloud Patch deleted' });
    return true;
  } catch (e) {
    useToastStore
      .getState()
      .push({ kind: 'error', title: 'Could not delete Cloud Patch', body: errorText(e) });
    return false;
  }
}

export function openPatchRow(p: CloudPatch): void {
  void openPatchLink(p.e2e && p.hasKey ? p.shareUrl : p.webUrl);
}

/**
 * Left-panel CLOUD PATCHES section (spec 14 §4.2): tabs Created by me / Shared with me, rows with a ⋯ menu
 * (Copy link, Open, Edit visibility, Delete). Renders nothing unless a server is configured and the user is
 * signed in. Also registers the Cloud Patches palette commands while mounted.
 */
export function CloudPatchesSection({ repoId }: { repoId: RepoId }) {
  const avail = usePatchAvailability();
  const enabled = avail.configured && avail.signedIn;
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<'mine' | 'shared'>('mine');
  const list = usePatchList(tab, repoId, enabled && open);
  const qc = useQueryClient();
  const showMenu = useContextMenu((st) => st.show);

  useEffect(() => registerCommands(cloudPatchCommands()), []);

  if (!enabled) return null;
  const items = list.data?.items ?? [];

  const menu = (p: CloudPatch): MenuEntry[] => [
    { label: 'Copy link', onSelect: () => copyPatchLink(p) },
    {
      label: 'Open',
      disabled: p.e2e && !p.hasKey,
      title:
        p.e2e && !p.hasKey ? 'Open the full link (with its key) to view this encrypted patch' : undefined,
      onSelect: () => openPatchRow(p),
    },
    ...(p.mine
      ? [
          {
            label: 'Edit visibility…',
            onSelect: () => void import('./PatchSettingsDialog').then((m) => m.openPatchSettings(p, avail)),
          },
          'separator' as const,
          { label: 'Delete', danger: true, onSelect: () => void deletePatch(p) },
        ]
      : []),
  ];

  return (
    <section className={leftStyles.section}>
      <div className={leftStyles.sectionHeaderRow}>
        <button
          type="button"
          className={leftStyles.sectionHeader}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Cloud size={14} />
          <span className={leftStyles.sectionTitle}>Cloud Patches</span>
          {list.data && <span className={leftStyles.count}>{items.length}</span>}
        </button>
        <button
          type="button"
          className={s.iconBtn}
          style={{ marginRight: 6 }}
          aria-label="Refresh Cloud Patches"
          title="Refresh"
          onClick={() => void qc.invalidateQueries({ queryKey: patchKeys.all })}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {open && (
        <div>
          <div className={s.tabs} role="group" aria-label="Cloud Patches">
            <button type="button" aria-pressed={tab === 'mine'} onClick={() => setTab('mine')}>
              Created by me
            </button>
            <button type="button" aria-pressed={tab === 'shared'} onClick={() => setTab('shared')}>
              Shared with me
            </button>
          </div>
          {list.data?.offline && <p className={leftStyles.empty}>Offline — showing cached patches.</p>}
          {list.isPending && <p className={leftStyles.empty}>Loading…</p>}
          {list.error && <p className={leftStyles.empty}>{errorText(list.error)}</p>}
          {list.data && items.length === 0 && (
            <p className={leftStyles.empty}>
              {tab === 'mine' ? 'No Cloud Patches yet' : 'Nothing shared with you'}
            </p>
          )}
          <div role="list" aria-label={tab === 'mine' ? 'Created by me' : 'Shared with me'}>
            {items.map((p) => {
              const Vis = VIS_ICON[p.visibility];
              const created = Math.floor(Date.parse(p.createdAt) / 1000);
              const files = p.files?.length;
              return (
                <div
                  key={p.id}
                  role="listitem"
                  tabIndex={0}
                  className={s.row}
                  title={`${patchTitle(p)}\n${p.repo ? `${p.repo.owner}/${p.repo.name} · ` : ''}${
                    files !== undefined ? `${files} file${files === 1 ? '' : 's'} · ` : ''
                  }${VIS_LABEL[p.visibility]}${p.mine ? '' : ` · by ${p.author.name}`}`}
                  onDoubleClick={() => openPatchRow(p)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') openPatchRow(p);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    showMenu(e.clientX, e.clientY, menu(p));
                  }}
                >
                  {p.e2e ? <Lock size={12} aria-label="End-to-end encrypted" /> : <Vis size={12} />}
                  <span className={s.rowTitle}>{patchTitle(p)}</span>
                  <span className={s.rowMeta}>
                    {files !== undefined ? `${files} · ` : ''}
                    {formatDate(created)}
                  </span>
                  <button
                    type="button"
                    className={s.iconBtn}
                    aria-label={`Actions for ${patchTitle(p)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const r = e.currentTarget.getBoundingClientRect();
                      showMenu(r.left, r.bottom, menu(p));
                    }}
                  >
                    <Ellipsis size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
