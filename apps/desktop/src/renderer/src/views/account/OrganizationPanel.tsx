import type { Invite, OrgDetail, OrgPolicies, OrgRole, Team } from '@githappens/cloud-api/types';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Copy, Trash2, UserMinus, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { confirm, prompt } from '../../components/Dialogs';
import { UserAvatar } from '../../integrations/ui';
import { cloudErrorText, cloudInvoke, copyText } from '../../cloud/api';
import { ck, useCloudStatus, useOrgDetail, useOrgInvites } from '../../cloud/queries';
import prefs from '../preferences/PreferencesView.module.css';
import s from './Account.module.css';

const ROLE_LABEL: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      setError(cloudErrorText(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

/**
 * Preferences → Organization (spec 14 §4.6, §6.7): create/switch org, members and roles, invites by
 * email (with a copyable accept link), teams and policies including footprint privacy. No seats or
 * billing. Shows a hint when signed out; never calls the network without a session.
 */
export function OrganizationPanel() {
  const { data: status } = useCloudStatus();
  const session = status?.session;
  const qc = useQueryClient();
  const { error, busy, run } = useAction();
  const [name, setName] = useState('');

  if (!session) {
    return (
      <div className={prefs.group} data-testid="organization-panel">
        <h3 className={prefs.groupTitle}>Organization</h3>
        <p className={s.muted}>Sign in to GitHappens Cloud to create or join an organization.</p>
      </div>
    );
  }

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const org = await run(() => cloudInvoke('org:create', { name: name.trim() }));
    if (org) {
      setName('');
      await run(() => cloudInvoke('cloud:setActiveOrg', { orgId: org.id }));
      void qc.invalidateQueries({ queryKey: ck.status() });
    }
  };

  return (
    <div className={s.panel} data-testid="organization-panel">
      <div className={prefs.group}>
        <h3 className={prefs.groupTitle}>Organization</h3>
        <div className={s.inline}>
          {session.orgs.length > 0 && (
            <select
              aria-label="Active organization"
              value={session.activeOrgId ?? ''}
              disabled={busy}
              onChange={(e) => void run(() => cloudInvoke('cloud:setActiveOrg', { orgId: e.target.value }))}
            >
              {session.orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({ROLE_LABEL[o.role]})
                </option>
              ))}
            </select>
          )}
          <form className={s.inline} onSubmit={(e) => void create(e)}>
            <input
              type="text"
              aria-label="New organization name"
              placeholder="New organization name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button type="submit" disabled={busy || !name.trim()}>
              <Building2 size={13} aria-hidden /> Create organization
            </button>
          </form>
        </div>
        {session.orgs.length === 0 && (
          <p className={s.muted}>
            Organizations let teammates share Cloud Patches and workspaces and warn each other about
            overlapping work. Create one or open an invitation link.
          </p>
        )}
        {error && <p className={prefs.error}>{error}</p>}
      </div>
      {session.activeOrgId && <OrgDetails orgId={session.activeOrgId} myId={session.user.id} />}
    </div>
  );
}

function OrgDetails({ orgId, myId }: { orgId: string; myId: string }) {
  const qc = useQueryClient();
  const { data: org, error: loadError, isLoading } = useOrgDetail(orgId);
  const isAdmin = org?.myRole === 'owner' || org?.myRole === 'admin';
  const { data: invites } = useOrgInvites(orgId, !!isAdmin);
  const { error, busy, run } = useAction();
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ck.org(orgId) });
  };

  if (isLoading) return <p className={s.muted}>Loading organization…</p>;
  if (loadError || !org)
    return <p className={prefs.error}>{loadError ? cloudErrorText(loadError) : 'Not found.'}</p>;

  const rename = async (): Promise<void> => {
    const r = await prompt({
      title: 'Rename organization',
      label: 'Name',
      initial: org.name,
      okLabel: 'Rename',
    });
    if (r?.value.trim()) await run(() => cloudInvoke('org:rename', { orgId, name: r.value.trim() }));
    refresh();
  };

  return (
    <>
      <div className={prefs.group}>
        <h3 className={prefs.groupTitle}>
          {org.name} · {ROLE_LABEL[org.myRole]}
        </h3>
        <div className={s.inline}>
          {isAdmin && (
            <button type="button" disabled={busy} onClick={() => void rename()}>
              Rename
            </button>
          )}
          {org.myRole !== 'owner' && (
            <button
              type="button"
              className={s.dangerButton}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (
                    !(await confirm(
                      'Leave organization?',
                      `You will lose access to ${org.name}.`,
                      'Leave',
                      true,
                    ))
                  )
                    return;
                  await cloudInvoke('org:leave', { orgId });
                })
              }
            >
              Leave organization
            </button>
          )}
          {org.myRole === 'owner' && (
            <button
              type="button"
              className={s.dangerButton}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (
                    !(await confirm(
                      'Delete organization?',
                      `${org.name}, its teams and invitations will be deleted for everyone.`,
                      'Delete organization',
                      true,
                    ))
                  ) {
                    return;
                  }
                  await cloudInvoke('org:delete', { orgId });
                })
              }
            >
              <Trash2 size={13} aria-hidden /> Delete
            </button>
          )}
        </div>
        {error && <p className={prefs.error}>{error}</p>}
      </div>

      <Members org={org} myId={myId} isAdmin={!!isAdmin} onChanged={refresh} />
      {isAdmin && <Invites orgId={orgId} invites={invites ?? []} />}
      <Teams org={org} isAdmin={!!isAdmin} onChanged={refresh} />
      {isAdmin && <Policies org={org} onChanged={refresh} />}
    </>
  );
}

function Members({
  org,
  myId,
  isAdmin,
  onChanged,
}: {
  org: OrgDetail;
  myId: string;
  isAdmin: boolean;
  onChanged(): void;
}) {
  const { error, busy, run } = useAction();
  const canEdit = (role: OrgRole, userId: string): boolean =>
    isAdmin && userId !== myId && (role !== 'owner' || org.myRole === 'owner');
  return (
    <div className={prefs.group}>
      <h3 className={prefs.groupTitle}>Members ({org.members.length})</h3>
      <ul className={s.list}>
        {org.members.map((m) => (
          <li key={m.user.id} className={s.listItem}>
            <UserAvatar
              user={{
                login: m.user.email ?? m.user.name,
                name: m.user.name,
                email: m.user.email,
                avatarUrl: m.user.avatarUrl,
              }}
              size={22}
            />
            <span className={s.grow}>
              {m.user.name}
              {m.user.id === myId ? ' (you)' : ''} <span className={s.small}>{m.user.email}</span>
            </span>
            {canEdit(m.role, m.user.id) ? (
              <>
                <select
                  aria-label={`Role of ${m.user.name}`}
                  value={m.role}
                  disabled={busy}
                  onChange={(e) =>
                    void run(async () => {
                      await cloudInvoke('org:setRole', {
                        orgId: org.id,
                        userId: m.user.id,
                        role: e.target.value as OrgRole,
                      });
                      onChanged();
                    })
                  }
                >
                  {(org.myRole === 'owner' ? ['owner', 'admin', 'member'] : ['admin', 'member']).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r as OrgRole]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label={`Remove ${m.user.name}`}
                  title="Remove from organization"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (
                        !(await confirm(
                          'Remove member?',
                          `${m.user.name} will lose access to ${org.name}.`,
                          'Remove',
                          true,
                        ))
                      ) {
                        return;
                      }
                      await cloudInvoke('org:removeMember', { orgId: org.id, userId: m.user.id });
                      onChanged();
                    })
                  }
                >
                  <UserMinus size={13} aria-hidden />
                </button>
              </>
            ) : (
              <span className={s.small}>{ROLE_LABEL[m.role]}</span>
            )}
          </li>
        ))}
      </ul>
      {error && <p className={prefs.error}>{error}</p>}
    </div>
  );
}

function Invites({ orgId, invites }: { orgId: string; invites: Invite[] }) {
  const qc = useQueryClient();
  const { error, busy, run } = useAction();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('member');
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ck.invites(orgId) });

  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const inv = await run(() => cloudInvoke('org:invite', { orgId, email: email.trim(), role }));
    if (inv) {
      setLink({ email: inv.email, url: inv.acceptUrl });
      setEmail('');
      refresh();
    }
  };

  return (
    <div className={prefs.group}>
      <h3 className={prefs.groupTitle}>Invite people</h3>
      <form className={s.inline} onSubmit={(e) => void send(e)}>
        <input
          type="email"
          aria-label="Email to invite"
          placeholder="teammate@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <select aria-label="Invited role" value={role} onChange={(e) => setRole(e.target.value as OrgRole)}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit" className="primary" disabled={busy || !email.trim()}>
          Create invitation
        </button>
      </form>
      {link && (
        <div className={s.bannerInfo} role="status">
          <span className={s.grow}>
            Send this link to {link.email} (valid 7 days): <span className={s.mono}>{link.url}</span>
          </span>
          <button type="button" onClick={() => copyText(link.url)}>
            <Copy size={13} aria-hidden /> Copy link
          </button>
        </div>
      )}
      {invites.length > 0 && (
        <>
          <p className={s.muted}>Pending invitations</p>
          <ul className={s.list}>
            {invites.map((i) => (
              <li key={i.id} className={s.listItem}>
                <span className={s.grow}>
                  {i.email}{' '}
                  <span className={s.small}>
                    · {ROLE_LABEL[i.role]} · expires {new Date(i.expiresAt).toLocaleDateString()}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await cloudInvoke('org:revokeInvite', { orgId, inviteId: i.id });
                      refresh();
                    })
                  }
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p className={prefs.error}>{error}</p>}
    </div>
  );
}

function Teams({ org, isAdmin, onChanged }: { org: OrgDetail; isAdmin: boolean; onChanged(): void }) {
  const { error, busy, run } = useAction();
  const [name, setName] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (await run(() => cloudInvoke('org:createTeam', { orgId: org.id, name: name.trim() }))) {
      setName('');
      onChanged();
    }
  };
  const toggleMember = (team: Team, userId: string, on: boolean): void =>
    void run(async () => {
      const userIds = on
        ? [...new Set([...team.memberIds, userId])]
        : team.memberIds.filter((u) => u !== userId);
      await cloudInvoke('org:setTeamMembers', { orgId: org.id, teamId: team.id, userIds });
      onChanged();
    });

  return (
    <div className={prefs.group}>
      <h3 className={prefs.groupTitle}>Teams</h3>
      {org.teams.length === 0 && (
        <p className={s.muted}>No teams yet. Teams make sharing workspaces easier.</p>
      )}
      <ul className={s.list}>
        {org.teams.map((t) => (
          <li key={t.id}>
            <div className={s.listItem}>
              <Users size={14} aria-hidden />
              <span className={s.grow}>
                {t.name} <span className={s.small}>· {t.memberIds.length} members</span>
              </span>
              <button
                type="button"
                onClick={() => setOpen(open === t.id ? null : t.id)}
                aria-expanded={open === t.id}
              >
                {isAdmin ? 'Members' : 'Show'}
              </button>
              {isAdmin && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const r = await prompt({
                          title: 'Rename team',
                          label: 'Name',
                          initial: t.name,
                          okLabel: 'Rename',
                        });
                        if (!r?.value.trim()) return;
                        await cloudInvoke('org:renameTeam', {
                          orgId: org.id,
                          teamId: t.id,
                          name: r.value.trim(),
                        });
                        onChanged();
                      })
                    }
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete team ${t.name}`}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (!(await confirm('Delete team?', `Delete ${t.name}?`, 'Delete', true))) return;
                        await cloudInvoke('org:deleteTeam', { orgId: org.id, teamId: t.id });
                        onChanged();
                      })
                    }
                  >
                    <Trash2 size={13} aria-hidden />
                  </button>
                </>
              )}
            </div>
            {open === t.id && (
              <div className={s.teamMembers}>
                {org.members.map((m) => (
                  <label key={m.user.id}>
                    <input
                      type="checkbox"
                      checked={t.memberIds.includes(m.user.id)}
                      disabled={!isAdmin || busy}
                      onChange={(e) => toggleMember(t, m.user.id, e.target.checked)}
                    />
                    {m.user.name}
                  </label>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {isAdmin && (
        <form className={s.inline} onSubmit={(e) => void create(e)}>
          <input
            type="text"
            aria-label="New team name"
            placeholder="New team name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" disabled={busy || !name.trim()}>
            Create team
          </button>
        </form>
      )}
      {error && <p className={prefs.error}>{error}</p>}
    </div>
  );
}

function Policies({ org, onChanged }: { org: OrgDetail; onChanged(): void }) {
  const { error, busy, run } = useAction();
  const p = org.policies;
  const set = (patch: Partial<OrgPolicies>): void =>
    void run(async () => {
      await cloudInvoke('org:setPolicies', { orgId: org.id, policies: patch });
      onChanged();
    });
  const toggle = (
    key: 'allowPublicLinks' | 'footprintSharePaths' | 'footprintShareBranchNames',
    title: string,
    desc: string,
  ) => (
    <div className={prefs.row}>
      <div className={prefs.rowText}>
        <label htmlFor={`policy-${key}`} className={prefs.rowTitle}>
          {title}
        </label>
        <p className={prefs.rowDesc}>{desc}</p>
      </div>
      <div className={prefs.control}>
        <input
          id={`policy-${key}`}
          type="checkbox"
          role="switch"
          className={prefs.toggle}
          checked={p[key]}
          disabled={busy}
          onChange={(e) => set({ [key]: e.target.checked })}
        />
      </div>
      <span />
    </div>
  );
  return (
    <div className={prefs.group}>
      <h3 className={prefs.groupTitle}>Policies</h3>
      <div className={prefs.row}>
        <div className={prefs.rowText}>
          <label htmlFor="policy-expiry" className={prefs.rowTitle}>
            Maximum Cloud Patch expiry
          </label>
          <p className={prefs.rowDesc}>Members can&apos;t create patches that live longer than this.</p>
        </div>
        <div className={prefs.control}>
          <select
            id="policy-expiry"
            value={p.patchMaxExpiryDays === null ? '' : String(p.patchMaxExpiryDays)}
            disabled={busy}
            onChange={(e) => set({ patchMaxExpiryDays: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">No limit</option>
            {[7, 30, 90, 365].map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
            {p.patchMaxExpiryDays !== null && ![7, 30, 90, 365].includes(p.patchMaxExpiryDays) && (
              <option value={p.patchMaxExpiryDays}>{p.patchMaxExpiryDays} days</option>
            )}
          </select>
        </div>
        <span />
      </div>
      {toggle(
        'allowPublicLinks',
        'Allow "anyone with the link" patches',
        'Members may share Cloud Patches publicly by link.',
      )}
      {toggle(
        'footprintSharePaths',
        'Share file names in work footprints',
        'Off (recommended): teammates see hashed paths and only resolve names of files they also have.',
      )}
      {toggle(
        'footprintShareBranchNames',
        'Share branch names in work footprints',
        'Off: branches are identified by a hash only.',
      )}
      {error && <p className={prefs.error}>{error}</p>}
    </div>
  );
}
