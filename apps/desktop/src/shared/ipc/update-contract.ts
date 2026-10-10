/** Auto-update contract (spec 15 §5, §6.5). The updater lives in main; the renderer only observes it. */

export type UpdateChannel = 'stable' | 'preview';

export type UpdateState =
  /** Updates are off (dev / unpackaged build). */
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'ready'
  | 'error'
  /** In-place update unsupported (Linux deb/rpm/tar.gz): show a download link instead. */
  | 'manual';

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  channel: UpdateChannel;
  /** Version on offer (available / downloading / ready, and manual once a newer one is known). */
  version?: string;
  /** Download progress 0..1 while `downloading`. */
  progress?: number;
  bytesPerSecond?: number;
  error?: string;
  /** Release page to open for `manual` installs. */
  downloadUrl?: string;
  /** Epoch ms of the last completed check. */
  checkedAt?: number;
}

export interface WhatsNew {
  version: string;
  /** The CHANGELOG.md section for `version` (heading line excluded). */
  markdown: string;
}

export interface UpdateIpcContract {
  'update:status': { req: Record<string, never>; res: UpdateStatus };
  /** Checks the feed now; resolves with the status after the check settles. */
  'update:check': { req: Record<string, never>; res: UpdateStatus };
  /**
   * `ready` → quit and install. `available` (auto-download off) → start the download.
   * Otherwise a no-op.
   */
  'update:install': { req: Record<string, never>; res: void };
  /**
   * Release notes for the running version. Returns `null` unless this is the first launch after an
   * update (each version is shown once), or `force` is set (Help › What's new).
   */
  'update:whatsNew': { req: { force?: boolean }; res: WhatsNew | null };
}

export interface UpdateEventContract {
  'update:status': UpdateStatus;
}

export const UPDATE_INVOKE_CHANNELS = [
  'update:status',
  'update:check',
  'update:install',
  'update:whatsNew',
] as const satisfies readonly (keyof UpdateIpcContract)[];

export const UPDATE_EVENT_CHANNELS = [
  'update:status',
] as const satisfies readonly (keyof UpdateEventContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const invokeExhaustive: Exhaustive<keyof UpdateIpcContract, (typeof UPDATE_INVOKE_CHANNELS)[number]> = true;
const eventExhaustive: Exhaustive<keyof UpdateEventContract, (typeof UPDATE_EVENT_CHANNELS)[number]> = true;
void invokeExhaustive;
void eventExhaustive;
