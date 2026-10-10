import fs from 'node:fs';
import path from 'node:path';

import type { LaunchpadStateStatus } from '../../../shared/ipc/cloud-workspaces-contract';
import { CloudError, type CloudHttp } from '../cloud-http';
import { canonicalJson } from '../sync/canonical';
import { launchpadSource, type LaunchpadLike } from '../sync/adapters';

/**
 * Opt-in Launchpad state on the server (`/v1/launchpad/state`, spec 11 §6.6): pins, snoozes and saved
 * views as PLAINTEXT JSON, for users who want Launchpad state across computers without setting up
 * end-to-end encrypted settings sync. When E2E sync already carries the Launchpad category this does
 * nothing (no duplication). Merge: per item key, 3-way against the last synced document; when both
 * sides changed the same key, this computer wins.
 */
export interface LaunchpadStateDeps {
  cloud: CloudHttp;
  launchpad: LaunchpadLike;
  /** `cloud.launchpadState`. */
  enabled(): boolean;
  /** E2E settings sync is on with the Launchpad category. */
  e2eCovers(): boolean;
  profileDir(): string;
  onStatus?(s: LaunchpadStateStatus): void;
  now?(): number;
}

interface BaseFile {
  version: 1;
  server: string;
  userId: string;
  remoteVersion: number;
  items: Record<string, unknown>;
  syncedAt: string;
}

const DOC_FORMAT = 'githappens-launchpad/1';
const PUSH_DEBOUNCE_MS = 10_000;
const PULL_INTERVAL_MS = 15 * 60_000;

const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** Keyed 3-way merge; local wins conflicting edits. Exported for tests. */
export function mergeLaunchpadItems(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)])) {
    const l = local[k];
    const r = remote[k];
    const b = base[k];
    let pick: unknown;
    if (same(l, r)) pick = l;
    else if (same(l, b))
      pick = r; // only remote changed (incl. deletion)
    else if (same(r, b))
      pick = l; // only local changed
    else pick = l ?? r; // both changed: this computer wins (a local deletion loses to a remote edit)
    if (pick !== undefined) out[k] = pick;
  }
  return out;
}

export class LaunchpadStateSync {
  private readonly source;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private unsub: (() => void) | null = null;
  private running: Promise<LaunchpadStateStatus> | null = null;
  private applying = false;
  private last: Omit<LaunchpadStateStatus, 'enabled' | 'coveredByE2eSync' | 'available'> = {};

  constructor(private readonly d: LaunchpadStateDeps) {
    this.source = launchpadSource(d.launchpad);
  }

  status(): LaunchpadStateStatus {
    return {
      enabled: this.d.enabled(),
      coveredByE2eSync: this.d.e2eCovers(),
      available: !!this.d.cloud.serverUrl() && !!this.d.cloud.me(),
      ...this.last,
    };
  }

  private active(): boolean {
    const s = this.status();
    return s.enabled && !s.coveredByE2eSync && s.available;
  }

  start(): void {
    this.unsub = this.d.launchpad.onUserStateChange(() => {
      if (this.applying || !this.active()) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.syncNow().catch(() => undefined), PUSH_DEBOUNCE_MS);
      this.timer.unref?.();
    });
    this.interval = setInterval(() => {
      if (this.active()) void this.syncNow().catch(() => undefined);
    }, PULL_INTERVAL_MS);
    this.interval.unref?.();
    if (this.active()) void this.syncNow().catch(() => undefined);
  }

  /** Setting / session changed. */
  refresh(): void {
    if (this.active()) void this.syncNow().catch(() => undefined);
    else this.d.onStatus?.(this.status());
  }

  dispose(): void {
    this.unsub?.();
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
  }

  syncNow(): Promise<LaunchpadStateStatus> {
    this.running ??= this.run().finally(() => (this.running = null));
    return this.running;
  }

  private basePath(): string {
    return path.join(this.d.profileDir(), 'launchpad-server-state.json');
  }

  private readBase(server: string, userId: string): BaseFile | null {
    try {
      const f = JSON.parse(fs.readFileSync(this.basePath(), 'utf8')) as BaseFile;
      return f.version === 1 && f.server === server && f.userId === userId ? f : null;
    } catch {
      return null;
    }
  }

  private async run(): Promise<LaunchpadStateStatus> {
    if (!this.active()) {
      const s = this.status();
      this.d.onStatus?.(s);
      return s;
    }
    const server = this.d.cloud.serverUrl()!;
    const userId = this.d.cloud.me()!.id;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const remote = (
          await this.d.cloud.request<{ version: number; doc: Record<string, unknown> }>(
            'GET',
            '/v1/launchpad/state',
          )
        ).data;
        const remoteItems =
          remote.doc &&
          remote.doc.format === DOC_FORMAT &&
          remote.doc.items &&
          typeof remote.doc.items === 'object'
            ? (remote.doc.items as Record<string, unknown>)
            : {};
        const base = this.readBase(server, userId);
        const local = await this.source.read();
        const merged = mergeLaunchpadItems(base?.items ?? {}, local, remoteItems);
        if (!same(merged, local)) {
          this.applying = true;
          try {
            await this.source.write(merged);
          } finally {
            this.applying = false;
          }
        }
        let version = remote.version;
        if (!same(merged, remoteItems)) {
          try {
            version = (
              await this.d.cloud.request<{ version: number }>('PUT', '/v1/launchpad/state', {
                body: { doc: { format: DOC_FORMAT, items: merged } },
                headers: { 'if-match': String(remote.version) },
              })
            ).data.version;
          } catch (e) {
            if (e instanceof CloudError && e.code === 'precondition_failed') continue; // someone else wrote: re-merge
            throw e;
          }
        }
        const syncedAt = new Date(this.d.now?.() ?? Date.now()).toISOString();
        fs.mkdirSync(this.d.profileDir(), { recursive: true });
        fs.writeFileSync(
          this.basePath(),
          JSON.stringify({
            version: 1,
            server,
            userId,
            remoteVersion: version,
            items: merged,
            syncedAt,
          } satisfies BaseFile),
          'utf8',
        );
        this.last = { lastSyncAt: syncedAt, version };
        break;
      }
    } catch (e) {
      this.last = { ...this.last, error: (e as Error).message };
    }
    const s = this.status();
    this.d.onStatus?.(s);
    return s;
  }
}
