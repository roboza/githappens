import { nextZoneIndex } from './tab-model';

/**
 * F6 / Shift+F6 focus cycling between shell regions (spec 01 §7.18). Regions are elements marked
 * `data-focus-zone`; hidden ones are skipped. Focus goes to the zone's remembered / first focusable
 * element, else to the zone itself.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const lastFocus = new WeakMap<Element, HTMLElement>();

function visible(el: HTMLElement): boolean {
  return !el.closest('[hidden]') && el.getClientRects().length > 0;
}

export function cycleFocus(dir: 1 | -1): void {
  const zones = [...document.querySelectorAll<HTMLElement>('[data-focus-zone]')].filter(visible);
  if (!zones.length) return;
  const active = document.activeElement;
  const current = zones.findIndex((z) => active instanceof Node && z.contains(active));
  if (current >= 0 && active instanceof HTMLElement) lastFocus.set(zones[current]!, active);
  const zone = zones[nextZoneIndex(current, zones.length, dir)];
  if (!zone) return;
  const remembered = lastFocus.get(zone);
  const target =
    (remembered?.isConnected && zone.contains(remembered) && visible(remembered) ? remembered : null) ??
    [...zone.querySelectorAll<HTMLElement>(FOCUSABLE)].find(visible) ??
    zone;
  if (target === zone && !zone.hasAttribute('tabindex')) zone.tabIndex = -1;
  target.focus();
}
