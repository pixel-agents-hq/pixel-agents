/** Timing and endpoints for the fun services (week wall, weather). */

/** Days on the week wall, today included. */
export const WEEK_STATS_DAYS = 7;

/** Weather: how often Open-Meteo is polled. */
export const WEATHER_POLL_INTERVAL_MS = 30 * 60 * 1000;
/** Weather: one request's time limit. */
export const WEATHER_REQUEST_TIMEOUT_MS = 10_000;
/** Weather: the guessed city, cached in the data dir so the IP is looked up once. */
export const WEATHER_LOCATION_FILE_NAME = 'weather-location.json';

/** Set to 0/false/off/no to keep the board off the network for weather. */
export const WEATHER_ENABLED_ENV = 'PIXEL_AGENTS_WEATHER';

export function weatherEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[WEATHER_ENABLED_ENV]?.trim().toLowerCase();
  return !value || !['0', 'false', 'off', 'no'].includes(value);
}

/** IP → city guesses, tried in order (free, no key). ipapi.co is HTTPS; ip-api.com's free tier is HTTP only. */
export const WEATHER_IP_LOOKUP_URLS = [
  'https://ipapi.co/json/',
  'http://ip-api.com/json/',
] as const;

/** Open-Meteo current weather (free, no key). */
export function openMeteoUrl(latitude: number, longitude: number): string {
  const lat = latitude.toFixed(3);
  const lon = longitude.toFixed(3);
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,is_day`;
}
