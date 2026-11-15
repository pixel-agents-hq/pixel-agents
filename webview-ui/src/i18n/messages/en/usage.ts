/** English strings: usage. The source of truth — vi/usage.ts must carry every key. */
export const usage = {
  weekly: 'Weekly',
  fiveHour: '5-hour',
  resetLabel: '{name} · {reset}',
  ariaLabel:
    '{provider} usage. Weekly: {weeklyPercent} left, {weeklyReset}. 5-hour: {fiveHourPercent} left, {fiveHourReset}.',
  noData: 'no data yet',
  resetSinceReport: 'reset since the last report',
  resetsIn: 'resets in {duration}',
  updatesOnce: 'Updates once a {provider} session replies',
  updatedJustNow: 'Updated just now',
  updatedAgo: 'Updated {duration} ago',
} as const;
