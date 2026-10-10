import { create } from 'zustand';

import type { SettingsSection } from '../../../../shared/settings/registry';

/** Repo-specific sections (spec 13 §4.1 group "Repo: <name>"), shown while a repo tab is active. */
export const REPO_SECTIONS = [
  'Repo: Identity & Signing',
  'Repo: Commit',
  'Repo: Encoding',
  'Repo: Git Hooks',
  'Repo: Issues',
  'Repo: LFS & Git Flow',
  'Repo: Agents',
  'Repo: Performance',
] as const;
export type RepoSection = (typeof REPO_SECTIONS)[number];
export type PrefsSection = SettingsSection | RepoSection;

export const isRepoSection = (s: string): s is RepoSection =>
  (REPO_SECTIONS as readonly string[]).includes(s);

/** Which Preferences section is shown; lets commands open Preferences at a section. */
export const usePrefsNavStore = create<{ section: PrefsSection; go(section: PrefsSection): void }>((set) => ({
  section: 'General',
  go: (section) => set({ section }),
}));
