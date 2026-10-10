/**
 * Background maintenance (spec 14 §6.8 retention): purge expired/deleted patches and their blobs,
 * hard-delete accounts 7 days after deletion was requested (incl. blobs), expire footprints after
 * 14 days, drop abandoned pending uploads, and clean up expired auth state. Runs on an interval and
 * can be invoked directly (tests, admin tooling).
 */
import type { AppCore } from './context.ts';
import { ACCOUNT_DELETE_GRACE_MS } from './routes/account.ts';
import { FOOTPRINT_TTL_MS } from './routes/footprints.ts';

export const PENDING_PATCH_TTL_MS = 24 * 3_600_000;
const BATCH = 500;

export interface JobReport {
  patchesPurged: number;
  accountsPurged: number;
  footprintsExpired: number;
  authRowsCleaned: number;
}

export async function runJobs(app: AppCore): Promise<JobReport> {
  const now = new Date(app.now());
  const report: JobReport = { patchesPurged: 0, accountsPurged: 0, footprintsExpired: 0, authRowsCleaned: 0 };
  const { store, blobs } = app;

  // Accounts scheduled for deletion more than 7 days ago.
  for (const user of await store.listUsersDeletedBefore(new Date(now.getTime() - ACCOUNT_DELETE_GRACE_MS))) {
    for (const p of await store.listPatchesByAuthor(user.id)) await blobs.delete(p.id);
    // Orgs where they are the last owner: hand ownership to the longest-standing member, or delete
    // the org when nobody else is left.
    for (const { org, role } of await store.listOrgsForUser(user.id)) {
      const others = (await store.listMembers(org.id)).filter((m) => m.userId !== user.id);
      if (others.length === 0) {
        await store.markPatchesDeleted({ orgId: org.id }, now); // purged below
        await store.deleteOrg(org.id);
      } else if (role === 'owner' && !others.some((m) => m.role === 'owner')) {
        const heir = others.find((m) => m.role === 'admin') ?? others[0]!;
        await store.upsertMember({ ...heir, role: 'owner' });
      }
    }
    await store.purgeUser(user.id);
    report.accountsPurged++;
  }

  // Patches (after accounts, so org patches marked above go too): deleted, expired, or pending (never completed) for more than a day.
  for (;;) {
    const batch = await store.listPatchesToPurge(now, new Date(now.getTime() - PENDING_PATCH_TTL_MS), BATCH);
    for (const p of batch) {
      await blobs.delete(p.id);
      await store.hardDeletePatch(p.id);
      report.patchesPurged++;
    }
    if (batch.length < BATCH) break;
  }

  report.footprintsExpired = await store.deleteFootprintsBefore(new Date(now.getTime() - FOOTPRINT_TTL_MS));
  report.authRowsCleaned = await store.cleanupAuth(now);
  return report;
}

/** Start the interval timer; returns a stop function. */
export function scheduleJobs(app: AppCore, intervalSec: number): () => void {
  if (intervalSec <= 0) return () => undefined;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const r = await runJobs(app);
      const total = r.patchesPurged + r.accountsPurged + r.footprintsExpired + r.authRowsCleaned;
      if (total > 0) {
        app.logger.info({
          msg: 'maintenance',
          job: 'all',
          count: total,
          detail: `patches=${r.patchesPurged} accounts=${r.accountsPurged} footprints=${r.footprintsExpired} auth=${r.authRowsCleaned}`,
        });
      }
    } catch (err) {
      app.logger.error({ msg: 'maintenance failed', job: 'all', error: (err as Error)?.name ?? 'Error' });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 5_000);
  const timer = setInterval(() => void tick(), intervalSec * 1000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
