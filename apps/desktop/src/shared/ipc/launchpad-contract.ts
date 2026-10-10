import type {
  ClassifiedItem,
  ItemUserState,
  LaunchpadFilters,
  LaunchpadGroup,
  LaunchpadSourceError,
  LaunchpadSummary,
  LaunchpadTab,
  OpenPrCounts,
  PrNotification,
  SavedView,
  SnoozeState,
} from '@githappens/launchpad';

/**
 * Launchpad IPC (spec 11 §5.4). Items are fetched, classified and filtered in main; the renderer
 * does instant client-side text search/grouping with the same pure functions (@githappens/launchpad).
 * Mutating PR/issue actions reuse the integrations channels (`pr:checkout`, `pr:merge`, …).
 */

export interface LaunchpadQueryResult {
  items: ClassifiedItem[];
  /** One entry per failing source (footer chips); other sources' items are still returned. */
  errors: LaunchpadSourceError[];
  /** Epoch ms of the last completed refresh (or of the disk cache); null when never fetched. */
  fetchedAt: number | null;
  /** Data comes from the startup disk cache and a refresh hasn't completed yet. */
  stale: boolean;
  refreshing: boolean;
  /** Counts per view tab (before tab filtering, after scope/filters). */
  counts: Record<LaunchpadTab, number>;
  summary: LaunchpadSummary;
  /** At least one connected integration (otherwise show the "Connect a provider" hero). */
  hasIntegrations: boolean;
  /** Team mode was requested without a workspace scope (Team requires one). */
  teamUnavailable?: boolean;
}

export interface LaunchpadSummaryResult extends LaunchpadSummary {
  fetchedAt: number | null;
  hasIntegrations: boolean;
  /** Top actionable items for the status-bar tooltip. */
  top: Array<{ uid: string; title: string; group: LaunchpadGroup; ref: string }>;
}

/** Open PRs per workspace repo id (spec 11 §4.1 `RepoStatusSummary.openPrs`). */
export interface LaunchpadPrCountsResult {
  counts: Record<string, OpenPrCounts>;
  /** Totals include the workspace's team listing (otherwise only the viewer's own PRs are known). */
  complete: boolean;
  fetchedAt: number | null;
  hasIntegrations: boolean;
}

export interface LaunchpadIpcContract {
  /**
   * Classified items of the scope/mode in `filters`, filtered to `tab`. When the snapshot is older
   * than `maxAgeMs` a background refresh starts (`launchpad:updated` fires when done).
   */
  'launchpad:query': {
    req: { filters: LaunchpadFilters; tab: LaunchpadTab; maxAgeMs?: number; offline?: boolean };
    res: LaunchpadQueryResult;
  };
  /** Refresh now; `force` bypasses rate-limit back-off of failed sources. */
  'launchpad:refresh': { req: { force?: boolean; workspaceId?: string }; res: { fetchedAt: number | null } };
  /** Pin/unpin and snooze/unsnooze (null clears). Pinning clears a snooze and vice versa. */
  'launchpad:setItemState': {
    req: { uid: string; pin?: boolean; snooze?: SnoozeState | null };
    res: ItemUserState | null;
  };
  'launchpad:views': {
    req: Record<string, never>;
    res: { views: SavedView[]; lastFilters: LaunchpadFilters };
  };
  'launchpad:saveView': { req: { view: Omit<SavedView, 'id'> & { id?: string } }; res: SavedView };
  'launchpad:deleteView': { req: { id: string }; res: void };
  /** Personal-mode counts for the status bar; refreshes in the background when older than `maxAgeMs`. */
  'launchpad:summary': { req: { maxAgeMs?: number; offline?: boolean }; res: LaunchpadSummaryResult };
  /**
   * Open-PR counts (mine / total / needs my review) per repo of a workspace. Answers from memory;
   * data older than `maxAgeMs` (default 5 min) refreshes in the background (`launchpad:updated`).
   * `offline` = no requests (§6.5).
   */
  'launchpad:prCounts': {
    req: { workspaceId: string; maxAgeMs?: number; offline?: boolean };
    res: LaunchpadPrCountsResult;
  };
}

export interface LaunchpadEventContract {
  'launchpad:updated': { fetchedAt: number | null; summary: LaunchpadSummary };
  /**
   * Pull request events after a background refresh (`notifications.prEvents`): the renderer shows
   * one toast each (a batch opens the Launchpad). Items are list-only (no bodies).
   */
  'launchpad:prNotifications': { notifications: PrNotification[] };
  /** The OS notification of a PR event was clicked: open that PR (or the Launchpad for a batch). */
  'launchpad:openNotification': { id: string; item?: ClassifiedItem };
}

export const LAUNCHPAD_INVOKE_CHANNELS = [
  'launchpad:query',
  'launchpad:refresh',
  'launchpad:setItemState',
  'launchpad:views',
  'launchpad:saveView',
  'launchpad:deleteView',
  'launchpad:summary',
  'launchpad:prCounts',
] as const satisfies readonly (keyof LaunchpadIpcContract)[];

export const LAUNCHPAD_EVENT_CHANNELS = [
  'launchpad:updated',
  'launchpad:prNotifications',
  'launchpad:openNotification',
] as const satisfies readonly (keyof LaunchpadEventContract)[];
