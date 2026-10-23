/** `Monday, 19 October 2026` for a YYYY-MM-DD local day: models get weekdays
 *  wrong when left to work them out, so every report states it. */
export function longDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
