import { CircleDot, ClipboardList, SquareKanban, Ticket } from 'lucide-react';

import { trackerInfo, type TrackerIconName } from '../../integrations/issue-helpers';

const ICONS: Record<TrackerIconName, typeof CircleDot> = {
  github: CircleDot,
  gitlab: CircleDot,
  jira: Ticket,
  trello: SquareKanban,
  azure: ClipboardList,
};

/** Tinted tracker icon (GitHub / GitLab / Jira / Trello / Azure Boards). */
export function TrackerIcon({ kind, size = 12 }: { kind: string; size?: number }) {
  const info = trackerInfo(kind);
  const Icon = ICONS[info.icon];
  return <Icon size={size} style={{ color: info.color }} aria-label={info.label} />;
}
