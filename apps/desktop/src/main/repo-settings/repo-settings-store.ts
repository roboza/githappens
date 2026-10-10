import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import {
  DEFAULT_REPO_SETTINGS,
  DISPLAY_ENCODINGS,
  type RepoSettings,
} from '../../shared/ipc/repo-settings-contract';
import { readJson, writeFileAtomic } from '../settings/atomic-file';

/**
 * Per-profile, per-repo settings that have no git config key (spec 13 §5.1:
 * `profiles/<profileId>/repo-settings/<sha1(realpath)>.json`).
 */

const KNOWN_ENCODINGS = new Set(DISPLAY_ENCODINGS.map((e) => e.label));

/** Accepts our list plus any other label the runtime's TextDecoder knows. */
export function isSupportedEncoding(label: string): boolean {
  const l = label.trim().toLowerCase();
  if (KNOWN_ENCODINGS.has(l)) return true;
  try {
    new TextDecoder(l);
    return true;
  } catch {
    return false;
  }
}

const trackerSchema = z
  .object({
    integrationKey: z.string().min(1).max(300),
    kind: z.string().min(1).max(40),
    projectKey: z.string().max(300).optional(),
  })
  .strict();

const patchSchema = z
  .object({
    encoding: z
      .string()
      .max(40)
      .transform((s) => s.trim().toLowerCase())
      .refine(isSupportedEncoding, 'Unsupported encoding'),
    issueTracker: trackerSchema.nullable(),
  })
  .partial()
  .strict();

/** Validate a renderer patch; throws with a user-facing message. */
export function validateRepoSettingsPatch(patch: unknown): Partial<RepoSettings> {
  const r = patchSchema.safeParse(patch);
  if (!r.success)
    throw new Error(`Invalid repository settings: ${r.error.issues.map((i) => i.message).join('; ')}`);
  return r.data as Partial<RepoSettings>;
}

/** Stable key for a repository: sha1 of its real path (case-folded on Windows / macOS). */
export function repoKey(repoPath: string, platform: NodeJS.Platform = process.platform): string {
  let p = path.resolve(repoPath);
  try {
    p = fs.realpathSync.native(p);
  } catch {
    /* missing path: hash as given */
  }
  p = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (platform === 'win32' || platform === 'darwin') p = p.toLowerCase();
  return createHash('sha1').update(p).digest('hex');
}

export class RepoSettingsStore {
  /** `profileDir()` is re-read on every call so a profile switch is picked up. */
  constructor(private readonly profileDir: () => string) {}

  private file(repoPath: string): string {
    return path.join(this.profileDir(), 'repo-settings', `${repoKey(repoPath)}.json`);
  }

  get(repoPath: string): RepoSettings {
    const r = readJson<Record<string, unknown>>(this.file(repoPath));
    if (r.kind !== 'ok' || typeof r.value !== 'object' || r.value === null)
      return { ...DEFAULT_REPO_SETTINGS };
    const out: RepoSettings = { ...DEFAULT_REPO_SETTINGS };
    try {
      const v = validateRepoSettingsPatch({
        encoding: r.value.encoding ?? DEFAULT_REPO_SETTINGS.encoding,
        issueTracker: r.value.issueTracker ?? null,
      });
      Object.assign(out, v);
    } catch {
      /* invalid stored values fall back to defaults */
    }
    return out;
  }

  set(repoPath: string, patch: unknown): RepoSettings {
    const next = { ...this.get(repoPath), ...validateRepoSettingsPatch(patch) };
    writeFileAtomic(
      this.file(repoPath),
      `${JSON.stringify({ version: 1, repoPath: path.resolve(repoPath), ...next }, null, 2)}\n`,
    );
    return next;
  }
}
