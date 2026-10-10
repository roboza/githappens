import type { CloudWorkspaceDoc, WorkspaceShare } from '@githappens/cloud-api/types';

import type { Workspace } from './workspaces-contract';

export type { CloudWorkspaceDoc, WorkspaceShare };

/**
 * Cloud workspaces (spec 11 §6.6, spec 14 §4.6) and the opt-in Launchpad server state. A local workspace
 * is published to `/v1/workspaces` WITHOUT local paths (repo names + credential-free remote URLs only),
 * shared with the org / teams / members, and opened on another computer as a local `cloud` workspace
 * whose missing repositories can be cloned in one go. Links between local and cloud workspaces live in
 * the profile (`cloud-workspaces.json`), never on the server.
 */

export interface CloudWorkspaceInfo {
  id: string;
  name: string;
  description?: string;
  ownerUserId: string;
  /** Owned by the signed-in user. */
  mine: boolean;
  /** Owner, or admin of the workspace's org. */
  canWrite: boolean;
  orgId?: string;
  orgName?: string;
  version: number;
  updatedAt: string;
  shares: WorkspaceShare[];
  repos: CloudWorkspaceDoc['repos'];
  /** Local workspace linked to this cloud workspace on this computer. */
  localWorkspaceId?: string;
}

export interface CloudWorkspaceLinkStatus {
  linked: CloudWorkspaceInfo | null;
  /** The local workspace changed since it was last published / opened. */
  localChanged: boolean;
  /** The cloud copy is newer than what this computer last saw. */
  remoteChanged: boolean;
  /** Repos without a local clone. */
  missing: number;
}

export interface ShareTargets {
  orgs: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; orgId: string; name: string; memberCount: number }>;
  members: Array<{ id: string; orgId: string; name: string; email?: string }>;
}

export interface LaunchpadStateStatus {
  /** `cloud.launchpadState` setting. */
  enabled: boolean;
  /** End-to-end encrypted settings sync already carries Launchpad state: server state is skipped. */
  coveredByE2eSync: boolean;
  available: boolean;
  lastSyncAt?: string;
  version?: number;
  error?: string;
}

export interface CloudWorkspacesIpcContract {
  'cloudWorkspace:list': { req: Record<string, never>; res: { items: CloudWorkspaceInfo[] } };
  /** Create the cloud copy of a local workspace, or update the linked one (If-Match; 412 → conflict). */
  'cloudWorkspace:publish': {
    req: { workspaceId: string; orgId?: string; force?: boolean };
    res: CloudWorkspaceInfo;
  };
  'cloudWorkspace:share': { req: { id: string; shares: WorkspaceShare[] }; res: CloudWorkspaceInfo };
  'cloudWorkspace:shareTargets': { req: { orgId?: string }; res: ShareTargets };
  /** Create (or refresh) the local workspace for a cloud workspace; repos already cloned are located. */
  'cloudWorkspace:open': {
    req: { id: string; cloneRoot?: string };
    res: { workspace: Workspace; missing: string[] };
  };
  /** Clone the repos of a linked workspace that have no local copy (workspace bulk clone). */
  'cloudWorkspace:cloneMissing': {
    req: { workspaceId: string; cloneRoot?: string; protocol?: 'https' | 'ssh' };
    res: { bulkId: string | null; count: number };
  };
  'cloudWorkspace:status': { req: { workspaceId: string }; res: CloudWorkspaceLinkStatus };
  /** Forget the link on this computer (the cloud workspace stays). */
  'cloudWorkspace:unlink': { req: { workspaceId: string }; res: null };
  /** Delete the cloud workspace (owner / org admin). */
  'cloudWorkspace:delete': { req: { id: string }; res: null };
  'launchpadState:status': { req: Record<string, never>; res: LaunchpadStateStatus };
  'launchpadState:syncNow': { req: Record<string, never>; res: LaunchpadStateStatus };
}

export interface CloudWorkspacesEventContract {
  'cloudWorkspace:changed': {
    reason: 'published' | 'shared' | 'opened' | 'unlinked' | 'deleted' | 'session';
  };
  'launchpadState:statusChanged': LaunchpadStateStatus;
}

export const CLOUD_WORKSPACES_INVOKE_CHANNELS = [
  'cloudWorkspace:list',
  'cloudWorkspace:publish',
  'cloudWorkspace:share',
  'cloudWorkspace:shareTargets',
  'cloudWorkspace:open',
  'cloudWorkspace:cloneMissing',
  'cloudWorkspace:status',
  'cloudWorkspace:unlink',
  'cloudWorkspace:delete',
  'launchpadState:status',
  'launchpadState:syncNow',
] as const satisfies readonly (keyof CloudWorkspacesIpcContract)[];

export const CLOUD_WORKSPACES_EVENT_CHANNELS = [
  'cloudWorkspace:changed',
  'launchpadState:statusChanged',
] as const satisfies readonly (keyof CloudWorkspacesEventContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const invokeExhaustive: Exhaustive<
  keyof CloudWorkspacesIpcContract,
  (typeof CLOUD_WORKSPACES_INVOKE_CHANNELS)[number]
> = true;
const eventExhaustive: Exhaustive<
  keyof CloudWorkspacesEventContract,
  (typeof CLOUD_WORKSPACES_EVENT_CHANNELS)[number]
> = true;
void invokeExhaustive;
void eventExhaustive;
