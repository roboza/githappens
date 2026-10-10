import { configureDates, dateOptionsFrom } from '../lib/format';
import { relativeClock } from '../lib/relative-clock';
import { useSettingsStore } from '../stores/settings';
import { useToastStore } from '../stores/toasts';

/**
 * Applies display settings that plain modules (not components) read: `ui.dateLocale` / `ui.hour12`
 * for every `formatDate` call. Imported once by ToastHost (always mounted).
 */
let lastKey = '';
function apply(): void {
  const v = useSettingsStore.getState().values;
  const locale = v?.['ui.dateLocale'];
  const hour12 = v?.['ui.hour12'];
  const key = `${locale}|${hour12}`;
  if (key === lastKey) return;
  lastKey = key;
  configureDates(dateOptionsFrom(locale, hour12));
  relativeClock.bump(); // relative dates on screen re-render in the new locale
}

/** Profile with an empty name/email (spec 13 §8): prompt once per profile per session. */
const prompted = new Set<string>();
function checkProfile(): void {
  const { ready, profile } = useSettingsStore.getState();
  if (!ready || !profile || prompted.has(profile.id)) return;
  if (profile.authorName.trim() && profile.authorEmail.trim()) return;
  prompted.add(profile.id);
  useToastStore.getState().push({
    kind: 'warning',
    key: `profile-identity:${profile.id}`,
    title: `Profile "${profile.name}" has no commit ${!profile.authorName.trim() ? 'name' : 'email'}`,
    body: 'Commits fall back to your git config. Set a name and email for this profile.',
    timeoutMs: null,
    actions: [
      {
        label: 'Set identity…',
        run: () => {
          window.dispatchEvent(new CustomEvent('kl:open-preferences', { detail: 'Profiles' }));
        },
      },
    ],
  });
}

function onChange(): void {
  apply();
  checkProfile();
}

onChange();
useSettingsStore.subscribe(onChange);
