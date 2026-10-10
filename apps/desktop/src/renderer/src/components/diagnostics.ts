import type { GitExecutableInfo } from '@githappens/git/types';

import type { BundledGitInfo } from '../../../shared/ipc/about-contract';
import type { SecretStoreStatus, VersionInfo } from '../../../shared/ipc/app-contract';

export interface DiagnosticsInput {
  versions?: VersionInfo;
  engine?: GitExecutableInfo;
  bundled?: BundledGitInfo | null;
  secrets?: SecretStoreStatus;
  platform: string;
  userAgent?: string;
}

/**
 * Plain-text block for "Copy diagnostics" (spec 15 §4 About dialog). No personal data: no profile
 * name/email, no repository paths — only versions, the git executable and the platform.
 */
export function formatDiagnostics(d: DiagnosticsInput): string {
  const v = d.versions;
  const lines = [
    `GitHappens ${v?.app ?? 'unknown'}`,
    `Electron ${v?.electron ?? '?'} · Chromium ${v?.chrome ?? '?'} · Node ${v?.node ?? '?'}`,
    `Platform: ${d.platform}`,
  ];
  if (d.engine) {
    lines.push(`Git (active): ${d.engine.version} (${d.engine.kind}) ${d.engine.path}`);
    lines.push(`Git LFS: ${d.engine.lfsVersion ?? 'not installed'}`);
    const off = Object.entries(d.engine.features)
      .filter(([, on]) => !on)
      .map(([k]) => k);
    lines.push(`Git features missing: ${off.length ? off.join(', ') : 'none'}`);
  } else if (v) {
    lines.push(`Git (active): ${v.git} ${v.gitPath}`);
  } else {
    lines.push('Git (active): not found');
  }
  if (d.bundled) {
    lines.push(
      d.bundled.available
        ? `Git (bundled): ${d.bundled.version ?? '?'} ${d.bundled.path ?? ''}`.trimEnd()
        : `Git (bundled): unavailable${d.bundled.error ? ` — ${d.bundled.error}` : ''}`,
    );
  }
  if (d.secrets)
    lines.push(`Secure storage: ${d.secrets.available ? 'available' : 'unavailable'} (${d.secrets.backend})`);
  if (d.userAgent) lines.push(`User agent: ${d.userAgent}`);
  return `${lines.join('\n')}\n`;
}
