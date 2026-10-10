import { readLocalIdentity, identityOverridden, type GitService, type RepoId } from '@githappens/git';

import type { BehaviourIpcContract, IdentityStatus } from '../../shared/ipc/behaviour-contract';
import type { AutoFetchScheduler } from '../services/auto-fetch';
import type { DesktopNotifier } from '../notify/desktop-notifier';
import type { HandlerContext } from './registry';

type Channel = Exclude<keyof BehaviourIpcContract, 'git:output:list' | 'git:output:clear'>;

export type BehaviourHandlers = {
  [C in Channel]: (
    req: BehaviourIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => BehaviourIpcContract[C]['res'] | Promise<BehaviourIpcContract[C]['res']>;
};

export interface BehaviourHandlerDeps {
  repos: { get(repoId: RepoId): GitService };
  autoFetch: Pick<AutoFetchScheduler, 'state' | 'resume' | 'setActive'>;
  notifier: Pick<DesktopNotifier, 'notify'>;
  profile: () => { authorName: string; authorEmail: string };
  openLogsFolder: () => void | Promise<unknown>;
}

/** Effective commit identity for a repo (spec 13 §6): repo-local > profile (when set) > git config. */
export async function identityStatus(
  service: GitService,
  profile: { authorName: string; authorEmail: string },
): Promise<IdentityStatus> {
  const local = await readLocalIdentity(service).catch(() => ({}) as { name?: string; email?: string });
  const p = { name: profile.authorName.trim(), email: profile.authorEmail.trim() };
  const gitValue = async (key: string): Promise<string | undefined> => {
    const r = await service
      .runRead(['config', '--get', key], { expectedExitCodes: [0, 1] })
      .catch(() => ({ exitCode: 1, stdout: '' }));
    return r.exitCode === 0 ? r.stdout.trim() || undefined : undefined;
  };
  const pick = async (
    key: 'name' | 'email',
  ): Promise<{ value?: string; source: 'repo' | 'profile' | 'git' }> => {
    if (local[key]) return { value: local[key], source: 'repo' };
    if (p[key]) return { value: p[key], source: 'profile' };
    return { value: await gitValue(`user.${key}`), source: 'git' };
  };
  const [name, email] = await Promise.all([pick('name'), pick('email')]);
  return {
    profile: p,
    local,
    effective: {
      name: name.value,
      email: email.value,
      source: name.source === email.source ? name.source : 'mixed',
    },
    overridden: identityOverridden(p, local),
    profileIncomplete: !p.name || !p.email,
  };
}

/** Notifications, auto-fetch, identity status and logs folder IPC (Phase 7). */
export function createBehaviourHandlers(d: BehaviourHandlerDeps): BehaviourHandlers {
  return {
    'notify:desktop': ({ title, body, force }) => d.notifier.notify(title, body, !!force),
    'autofetch:state': ({ repoId }) => d.autoFetch.state(repoId),
    'autofetch:resume': ({ repoId }) => d.autoFetch.resume(repoId),
    'autofetch:setActive': ({ repoId }) => d.autoFetch.setActive(repoId),
    'identity:status': ({ repoId }) => identityStatus(d.repos.get(repoId), d.profile()),
    'logs:open': async () => {
      await d.openLogsFolder();
    },
  };
}
