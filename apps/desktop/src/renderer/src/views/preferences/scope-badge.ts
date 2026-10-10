import type { SettingScope } from '../../../../shared/settings/registry';

/** Scope badge text for setting rows (spec 13 §4.1 `SettingRow` scope badge [App|Profile|Repo|Git config]). */
export interface ScopeBadgeInfo {
  label: string;
  title: string;
  /** Accent style for scopes outside the profile (app-wide, repo, git config). */
  accent: boolean;
}

const BADGES: Record<SettingScope, ScopeBadgeInfo> = {
  app: { label: 'App', title: 'Applies to every profile on this computer', accent: true },
  profile: { label: 'Profile', title: 'Stored in the active profile', accent: false },
  repo: { label: 'Repo', title: 'Stored for this repository (in your profile)', accent: true },
  gitGlobal: { label: 'Git config', title: 'Written to ~/.gitconfig', accent: true },
  gitLocal: { label: 'Git config', title: "Written to this repository's .git/config", accent: true },
};

export function scopeBadge(scope: string): ScopeBadgeInfo {
  return BADGES[scope as SettingScope] ?? { label: scope, title: scope, accent: true };
}
