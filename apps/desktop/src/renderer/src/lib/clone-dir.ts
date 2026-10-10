import { useSettingsStore } from '../stores/settings';

const LAST_KEY = 'clone:parentDir';

/**
 * Parent folder suggested by clone dialogs and workspace bulk clone (spec 13 `general.defaultCloneDirectory`):
 * the configured folder, else the last folder used.
 */
export function initialCloneDir(): string {
  const configured = useSettingsStore.getState().values?.['general.defaultCloneDirectory']?.trim();
  if (configured) return configured;
  try {
    return localStorage.getItem(LAST_KEY) ?? '';
  } catch {
    return '';
  }
}
