import type { SettingDescriptor, SettingKey, SettingScope, SettingsValues } from '../settings/registry';

export interface VersionInfo {
  app: string;
  electron: string;
  chrome: string;
  node: string;
  git: string;
  gitPath: string;
}

export interface ProfileMeta {
  id: string;
  name: string;
  authorName: string;
  authorEmail: string;
  syncGitConfig: boolean;
  avatarSource: 'provider' | 'gravatar' | 'initials';
  createdAt: number;
}

export interface SettingsSnapshot {
  values: SettingsValues;
  profile: ProfileMeta;
  registry: SettingDescriptor[];
}

export interface SettingsChange {
  key: SettingKey;
  value: unknown;
  scope: SettingScope;
}

/** Main-initiated toast (renderer owns the toast UI, spec 01 `ToastSpec`). */
export interface ToastSpec {
  id?: string;
  kind: 'success' | 'info' | 'warning' | 'error' | 'progress';
  title: string;
  body?: string;
  timeoutMs?: number | null;
}

export interface SecretStoreStatus {
  available: boolean;
  backend: string;
}

/** App, shell and settings channels (specs 01, 13, 15). */
export interface AppIpcContract {
  'app:getVersionInfo': { req: Record<string, never>; res: VersionInfo };
  'app:secretStoreStatus': { req: Record<string, never>; res: SecretStoreStatus };
  'settings:getAll': { req: Record<string, never>; res: SettingsSnapshot };
  'settings:set': { req: { key: SettingKey; value: unknown }; res: void };
  'settings:reset': { req: { key?: SettingKey }; res: void };
}

export interface AppEventContract {
  'settings:changed': SettingsChange;
  'shell:toast': ToastSpec;
}
