import { MONTHS } from '../components/ui/pixelFont.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago `at` was, as short as a sidebar row needs: "now", "5m",
 *  "3h", "2d", then the date ("OCT 13", the pixel font's month names). */
export function timeAgo(at: number, now: number): string {
  const ago = Math.max(0, now - at);
  if (ago < MINUTE) return 'now';
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)}m`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)}h`;
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)}d`;
  const date = new Date(at);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}
