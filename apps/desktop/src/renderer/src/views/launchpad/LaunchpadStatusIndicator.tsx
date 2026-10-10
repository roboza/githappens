import { Ban, CircleCheck, CircleDot, Rocket } from 'lucide-react';

import { groupLabel, showStatusIndicator, STATUS_COUNTERS } from '../../launchpad/helpers';
import { useLaunchpadSummary } from '../../launchpad/queries';
import { useSetting } from '../../stores/settings';
import { useTabsStore } from '../../stores/tabs';
import s from './Launchpad.module.css';

const ICON = { needsReview: CircleDot, readyToMerge: CircleCheck, blocked: Ban } as const;
const TONE = { needsReview: 'tone-blue', readyToMerge: 'tone-green', blocked: 'tone-red' } as const;

/**
 * Status-bar Launchpad summary (spec 11 §4.3): up to three counters; a click opens the Launchpad tab
 * (Personal, PR view) with that group expanded. Hidden per `launchpad.statusBar`.
 */
export function LaunchpadStatusIndicator() {
  const mode = useSetting('launchpad.statusBar');
  const q = useLaunchpadSummary(mode !== 'never');
  const d = q.data;
  if (!showStatusIndicator(mode, d) || !d) return null;

  const open = (group?: (typeof STATUS_COUNTERS)[number]['group']) =>
    useTabsStore.getState().openLaunchpad({ tab: 'prs', group, mode: 'personal' });
  const tooltip = [
    `Launchpad${d.partial ? ' (some sources failed)' : ''}`,
    d.noReviewers ? `${d.noReviewers} without reviewers` : '',
    d.conflicts ? `${d.conflicts} with conflicts` : '',
    ...d.top.map((t) => `• ${groupLabel(t.group)}: ${t.ref} ${t.title}`),
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <span className={s.indicator} title={tooltip} role="group" aria-label="Launchpad summary">
      <button type="button" className={s.indicator} onClick={() => open()} aria-label="Open Launchpad">
        <Rocket size={12} aria-hidden />
      </button>
      {STATUS_COUNTERS.filter((c) => d[c.key] > 0 || mode === 'always').map((c) => {
        const Icon = ICON[c.key];
        return (
          <button
            key={c.key}
            type="button"
            className={`${s.indicator} ${s.counter}`}
            onClick={() => open(c.group)}
            aria-label={`${d[c.key]} ${groupLabel(c.group)}`}
          >
            <Icon size={11} className={s[TONE[c.key]]} aria-hidden />
            {d[c.key]} {c.label}
          </button>
        );
      })}
    </span>
  );
}
