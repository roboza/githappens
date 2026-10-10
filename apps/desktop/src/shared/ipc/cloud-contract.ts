import type {
  IdpId,
  Invite,
  Org,
  OrgDetail,
  OrgMember,
  OrgPolicies,
  OrgRole,
  ServerInfo,
  Team,
} from '@githappens/cloud-api/types';

/**
 * Account, settings sync and organizations IPC (spec 14 §5.4). Tokens, the sync data-encryption key
 * and passphrases never cross IPC in the main → renderer direction; the renderer only sees session
 * metadata. Cloud failures arrive as IpcResult errors whose `details.cloudCode` carries the
 * `CloudError` code ('network', 'unauthorized', 'precondition_failed', …).
 */

/** Signed-in account (spec 14 §5.4 `CloudSession`). */
export interface CloudSession {
  serverUrl: string;
  user: { id: string; email: string; name: string; avatarUrl?: string };
  orgs: Array<{ id: string; name: string; slug: string; role: OrgRole }>;
  activeOrgId?: string;
}

export interface CloudStatus {
  /** Normalized `cloud.serverUrl`, or null when cloud features are off. */
  serverUrl: string | null;
  /** The configured URL is not a valid server address (https required except localhost). */
  serverUrlError?: string;
  session: CloudSession | null;
  /** The last request failed with a network error; session data is cached. */
  offline: boolean;
  /** A browser sign-in is in progress. */
  signingIn: boolean;
  /** The session ended unexpectedly (refresh token expired / revoked). */
  expired?: boolean;
}

/** Desktop sync categories (spec 14 §5.4 minus `_keys`; `profiles` is not synced yet). */
export type SyncDataCategory =
  'preferences' | 'keybindings' | 'themes' | 'workspaces-local' | 'launchpad' | 'integrations-list';

export const SYNC_DATA_CATEGORIES: readonly SyncDataCategory[] = [
  'preferences',
  'keybindings',
  'themes',
  'workspaces-local',
  'launchpad',
  'integrations-list',
];

export const SYNC_CATEGORY_LABELS: Record<SyncDataCategory, string> = {
  preferences: 'Preferences',
  keybindings: 'Keybindings',
  themes: 'Themes',
  'workspaces-local': 'Workspaces',
  launchpad: 'Launchpad state',
  'integrations-list': 'Connected services list',
};

/** A connected service known from another computer but not connected here ("Reconnect GitHub"). */
export interface ReconnectHint {
  key: string;
  kind: string;
  host: string;
  login: string;
}

export interface SyncStatus {
  /** `sync.enabled`. */
  enabled: boolean;
  categories: Record<SyncDataCategory, boolean>;
  /** Server configured and signed in. */
  available: boolean;
  /** missing = no sync keys on the server yet (passphrase setup needed); locked = enter passphrase. */
  keyState: 'unknown' | 'missing' | 'locked' | 'unlocked';
  state: 'off' | 'idle' | 'syncing' | 'error' | 'locked';
  lastSyncAt?: string;
  error?: string;
  /** Categories whose local and remote changes could not be merged automatically. */
  conflicts: Array<{ category: SyncDataCategory; keys: string[] }>;
  /** Categories skipped because the remote data was written by a newer app version. */
  skipped: Array<{ category: SyncDataCategory; reason: string }>;
  reconnect: ReconnectHint[];
  /** A recovery key is stored on this computer and can be shown again. */
  hasRecoveryKey: boolean;
}

/** TLS certificate a cloud server presents (self-signed server trust prompt, spec 14 §8). */
export interface CertificateInfo {
  origin: string;
  /** Uppercase colon-separated SHA-256 of the leaf certificate (DER). */
  fingerprint256: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  selfSigned: boolean;
  /** The OS / Chromium trust store accepts it (no prompt needed). */
  trustedBySystem: boolean;
  /** Verification error when not trusted (e.g. DEPTH_ZERO_SELF_SIGNED_CERT). */
  error?: string;
  /** Pinned by the user for this origin. */
  pinned: boolean;
}

export type CloudDeepLink =
  | { kind: 'invite'; token: string; url: string }
  /** `githappens://patch/<id>#k=<key>`; handled by the Cloud Patches UI. */
  | { kind: 'patch'; id: string; url: string }
  | { kind: 'suggestion'; id: string; url: string };

export interface CloudIpcContract {
  // ---- account ----
  'cloud:state': { req: Record<string, never>; res: CloudStatus };
  /** Checks `<url>/.well-known/githappens-cloud` without saving the URL. */
  'cloud:validateServer': { req: { url: string }; res: { url: string; info: ServerInfo } };
  /** ServerInfo of the configured server (cached); null when cloud is off. */
  'cloud:serverInfo': { req: { refresh?: boolean }; res: ServerInfo | null };
  /** System browser + loopback PKCE (spec 14 §6.1). */
  'cloud:signIn': { req: { idp: IdpId; loginHint?: string }; res: CloudSession };
  'cloud:cancelSignIn': { req: Record<string, never>; res: void };
  'cloud:signOut': { req: Record<string, never>; res: void };
  'cloud:session': { req: Record<string, never>; res: CloudSession | null };
  /** Re-fetch `/v1/me` (orgs list). */
  'cloud:refresh': { req: Record<string, never>; res: CloudSession | null };
  'cloud:setActiveOrg': { req: { orgId: string }; res: CloudSession };
  /** Schedules account deletion on the server, then signs out. */
  'cloud:deleteAccount': { req: Record<string, never>; res: { deleteAfter: string } };
  /** Deep links received before the UI was ready (and not yet handled). */
  'cloud:takeDeepLinks': { req: { kinds?: CloudDeepLink['kind'][] }; res: CloudDeepLink[] };
  /** Certificate a https server presents (TLS handshake without verification; nothing is sent). */
  'cloud:inspectCertificate': { req: { url: string }; res: CertificateInfo };
  /** Explicit consent: pin this certificate fingerprint for the server origin (must match what it presents now). */
  'cloud:trustCertificate': { req: { url: string; fingerprint256: string }; res: CertificateInfo };
  'cloud:untrustCertificate': { req: { url: string }; res: void };
  'cloud:trustedCertificates': {
    req: Record<string, never>;
    res: Array<{ origin: string; fingerprint256: string; subject: string; validTo: string; addedAt: string }>;
  };

  // ---- settings sync ----
  'sync:status': { req: Record<string, never>; res: SyncStatus };
  'sync:setEnabled': {
    req: { enabled?: boolean; categories?: Partial<Record<SyncDataCategory, boolean>> };
    res: SyncStatus;
  };
  'sync:now': { req: Record<string, never>; res: SyncStatus };
  'sync:resolveConflict': { req: { category: SyncDataCategory; keep: 'local' | 'remote' }; res: SyncStatus };
  /**
   * First setup (no keys on the server): creates the keys and returns the new recovery key (shown
   * once). When already unlocked: changes the passphrase (recoveryKey null).
   */
  'sync:setupPassphrase': { req: { passphrase: string }; res: { recoveryKey: string | null } };
  'sync:unlock': { req: { passphrase?: string; recoveryKey?: string }; res: SyncStatus };
  /** Shows the stored recovery key, or creates a new one (invalidating the old) when `regenerate`. */
  'sync:exportRecoveryKey': { req: { regenerate?: boolean }; res: { recoveryKey: string } };
  /** Lost passphrase: deletes all server sync data, creates new keys and re-uploads from this device. */
  'sync:reset': { req: { passphrase: string }; res: { recoveryKey: string } };
  /** Danger zone: deletes all server sync data and turns sync off. */
  'sync:deleteCloudData': { req: Record<string, never>; res: SyncStatus };
  'sync:dismissReconnect': { req: { key: string }; res: SyncStatus };

  // ---- organizations ----
  'org:create': { req: { name: string; slug?: string }; res: Org };
  'org:get': { req: { orgId: string }; res: OrgDetail };
  'org:rename': { req: { orgId: string; name: string }; res: Org };
  'org:delete': { req: { orgId: string }; res: void };
  'org:setPolicies': { req: { orgId: string; policies: Partial<OrgPolicies> }; res: OrgPolicies };
  'org:setRole': { req: { orgId: string; userId: string; role: OrgRole }; res: OrgMember };
  'org:removeMember': { req: { orgId: string; userId: string }; res: void };
  'org:leave': { req: { orgId: string }; res: void };
  'org:invite': { req: { orgId: string; email: string; role: OrgRole }; res: Invite & { acceptUrl: string } };
  'org:invites': { req: { orgId: string }; res: Invite[] };
  'org:revokeInvite': { req: { orgId: string; inviteId: string }; res: void };
  'org:acceptInvite': { req: { token: string }; res: Org };
  'org:teams': { req: { orgId: string }; res: Team[] };
  'org:createTeam': { req: { orgId: string; name: string }; res: Team };
  'org:renameTeam': { req: { orgId: string; teamId: string; name: string }; res: Team };
  'org:deleteTeam': { req: { orgId: string; teamId: string }; res: void };
  'org:setTeamMembers': { req: { orgId: string; teamId: string; userIds: string[] }; res: Team };
}

export interface CloudEventContract {
  'cloud:sessionChanged': CloudStatus;
  'sync:statusChanged': SyncStatus;
  /** A `githappens://` link arrived (also queued for `cloud:takeDeepLinks`). */
  'cloud:deepLink': CloudDeepLink;
}

export const CLOUD_INVOKE_CHANNELS = [
  'cloud:state',
  'cloud:validateServer',
  'cloud:serverInfo',
  'cloud:signIn',
  'cloud:cancelSignIn',
  'cloud:signOut',
  'cloud:session',
  'cloud:refresh',
  'cloud:setActiveOrg',
  'cloud:deleteAccount',
  'cloud:takeDeepLinks',
  'cloud:inspectCertificate',
  'cloud:trustCertificate',
  'cloud:untrustCertificate',
  'cloud:trustedCertificates',
  'sync:status',
  'sync:setEnabled',
  'sync:now',
  'sync:resolveConflict',
  'sync:setupPassphrase',
  'sync:unlock',
  'sync:exportRecoveryKey',
  'sync:reset',
  'sync:deleteCloudData',
  'sync:dismissReconnect',
  'org:create',
  'org:get',
  'org:rename',
  'org:delete',
  'org:setPolicies',
  'org:setRole',
  'org:removeMember',
  'org:leave',
  'org:invite',
  'org:invites',
  'org:revokeInvite',
  'org:acceptInvite',
  'org:teams',
  'org:createTeam',
  'org:renameTeam',
  'org:deleteTeam',
  'org:setTeamMembers',
] as const satisfies readonly (keyof CloudIpcContract)[];

export const CLOUD_EVENT_CHANNELS = [
  'cloud:sessionChanged',
  'sync:statusChanged',
  'cloud:deepLink',
] as const satisfies readonly (keyof CloudEventContract)[];
