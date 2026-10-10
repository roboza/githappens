import { createHmac } from 'node:crypto';

import {
  repoIdentityKey,
  type Footprint,
  type FootprintPut,
  type OrgPolicies,
  type RepoIdentity,
} from '@githappens/cloud-api/types';

import type { TeammateOverlap } from '../../../shared/ipc/conflicts-contract';
import { MAX_FOOTPRINT_FILES, type LineRange, type OwnFootprintFile } from './footprint';

/** Ranges within this many lines of each other count as overlapping (spec 14 §6.5). */
export const OVERLAP_SLACK = 3;

export type FootprintPolicies = Pick<OrgPolicies, 'footprintSharePaths' | 'footprintShareBranchNames'>;

/**
 * `base64url(HMAC-SHA256(orgSalt, repoIdentityKey + ':' + value))` for paths and branch names — the same
 * bytes as `hmacBase64Url` in @githappens/cloud-api/patch-crypto (node:crypto here keeps WebCrypto DOM
 * types out of the main-process build).
 */
export const footprintHash = async (salt: string, repo: RepoIdentity, value: string): Promise<string> =>
  createHmac('sha256', Buffer.from(salt, 'base64url'))
    .update(`${repoIdentityKey(repo)}:${value}`, 'utf8')
    .digest('base64url');

export interface HashedFile extends OwnFootprintFile {
  pathHash: string;
}

export async function hashFiles(
  salt: string,
  repo: RepoIdentity,
  files: OwnFootprintFile[],
): Promise<HashedFile[]> {
  return Promise.all(files.map(async (f) => ({ ...f, pathHash: await footprintHash(salt, repo, f.path) })));
}

/**
 * Privacy shaping before upload (spec 14 §6.5): hashes always; plaintext path / branch label only when
 * the org policy allows it. Never any file contents.
 */
export async function shapeFootprint(input: {
  salt: string;
  policies: FootprintPolicies;
  repo: RepoIdentity;
  branch: string;
  baseRef: string;
  headSha: string;
  files: OwnFootprintFile[];
}): Promise<FootprintPut> {
  const { salt, policies, repo } = input;
  const hashed = await hashFiles(salt, repo, input.files.slice(0, MAX_FOOTPRINT_FILES));
  return {
    repo,
    branchHash: await footprintHash(salt, repo, input.branch),
    ...(policies.footprintShareBranchNames ? { branchLabel: input.branch } : {}),
    baseRef: input.baseRef,
    headSha: input.headSha,
    files: hashed.map((f) => ({
      pathHash: f.pathHash,
      ...(policies.footprintSharePaths ? { path: f.path } : {}),
      ranges: f.ranges.map((r) => [r[0], r[1]] as LineRange),
    })),
  };
}

/** Ranges intersect within ±slack lines; an empty list (whole file / unknown) overlaps anything. */
export function rangesOverlap(a: LineRange[], b: LineRange[], slack = OVERLAP_SLACK): boolean {
  if (!a.length || !b.length) return true;
  return a.some(([as, ae]) => b.some(([bs, be]) => as - slack <= be && bs - slack <= ae));
}

/**
 * Teammate overlaps (client-side): same pathHash and overlapping ranges. Plaintext names come from the
 * caller's own files, so no plaintext path is needed from the server.
 */
export function findOverlaps(mine: HashedFile[], theirs: Footprint[]): TeammateOverlap[] {
  const byHash = new Map(mine.map((f) => [f.pathHash, f]));
  const out: TeammateOverlap[] = [];
  for (const fp of theirs) {
    for (const tf of fp.files) {
      const own = byHash.get(tf.pathHash);
      if (!own || !rangesOverlap(own.ranges, tf.ranges)) continue;
      out.push({
        user: {
          id: fp.user.id,
          name: fp.user.name,
          ...(fp.user.avatarUrl ? { avatarUrl: fp.user.avatarUrl } : {}),
        },
        ...(fp.branchLabel ? { branchLabel: fp.branchLabel } : {}),
        branchHash: fp.branchHash,
        path: own.path,
        pathHash: tf.pathHash,
        myRanges: own.ranges,
        theirRanges: tf.ranges,
        updatedAt: fp.updatedAt,
      });
    }
  }
  return out.sort((x, y) =>
    x.path < y.path ? -1 : x.path > y.path ? 1 : x.user.name.localeCompare(y.user.name),
  );
}
