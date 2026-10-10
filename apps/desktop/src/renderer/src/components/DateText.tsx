import type { SettingValue } from '../../../shared/settings/registry';
import { useFormattedDate } from '../lib/relative-clock';

/**
 * A commit / item date per `ui.dateFormat` that stays current (relative dates re-render on the shared
 * minute clock only when their text changes). Usable inside `.map()` where a hook can't be.
 */
export function DateText({
  unixSeconds,
  format,
}: {
  unixSeconds: number | undefined;
  format?: SettingValue<'ui.dateFormat'>;
}) {
  return <>{useFormattedDate(unixSeconds, format)}</>;
}
