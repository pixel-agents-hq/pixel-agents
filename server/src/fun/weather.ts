/**
 * Real weather in the office windows (docs/office/DESIGN.md, phase E).
 *
 * The city is guessed once from the PC's public IP (ipapi.co, falling back to
 * ip-api.com; both free, no key) and cached in the data dir. Open-Meteo's current
 * weather for it is polled every 30 min and broadcast as `weather`. Any network
 * or parse failure means no weather: nothing is sent and nothing is logged
 * beyond a debug line, so an offline PC just keeps plain windows.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { Weather, WeatherCondition } from '../../../core/src/messages.js';
import type { AgentStateStore } from '../agentStateStore.js';
import {
  openMeteoUrl,
  WEATHER_IP_LOOKUP_URLS,
  WEATHER_LOCATION_FILE_NAME,
  WEATHER_POLL_INTERVAL_MS,
  WEATHER_REQUEST_TIMEOUT_MS,
} from './funConstants.js';

export interface WeatherLocation {
  city: string;
  latitude: number;
  longitude: number;
}

/** GET a URL and parse its JSON body; rejects on any failure. */
export type FetchJson = (url: string, timeoutMs: number) => Promise<unknown>;

const defaultFetchJson: FetchJson = async (url, timeoutMs) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/** WMO weather interpretation code (Open-Meteo `weather_code`) → the windows' condition. */
export function conditionFromWmo(code: number): WeatherCondition {
  if (code === 45 || code === 48) return 'fog';
  if (code >= 95) return 'storm';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if (code === 2 || code === 3) return 'clouds';
  return 'clear'; // 0 clear sky, 1 mainly clear, and anything unknown
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A city guess from either IP lookup's JSON (ipapi.co or ip-api.com), or null. */
export function parseIpLocation(raw: unknown): WeatherLocation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.error === true || (typeof r.status === 'string' && r.status !== 'success')) return null;
  const latitude = finite(r.latitude) ? r.latitude : r.lat;
  const longitude = finite(r.longitude) ? r.longitude : r.lon;
  if (!finite(latitude) || !finite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const city = typeof r.city === 'string' && r.city.trim() ? r.city.trim().slice(0, 60) : '';
  return { city, latitude, longitude };
}

/** Open-Meteo's `current` block as a `weather` message, or null. */
export function parseOpenMeteo(raw: unknown, city: string): Weather | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const current = (raw as { current?: unknown }).current;
  if (typeof current !== 'object' || current === null) return null;
  const c = current as Record<string, unknown>;
  if (!finite(c.weather_code) || !finite(c.temperature_2m)) return null;
  return {
    type: 'weather',
    condition: conditionFromWmo(c.weather_code),
    isDay: c.is_day !== 0,
    tempC: Math.round(c.temperature_2m * 10) / 10,
    city,
  };
}

/** The cached city guess, or null when missing or malformed. */
export function readCachedLocation(file: string): WeatherLocation | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    if (!finite(raw.latitude) || !finite(raw.longitude)) return null;
    return {
      city: typeof raw.city === 'string' ? raw.city : '',
      latitude: raw.latitude,
      longitude: raw.longitude,
    };
  } catch {
    return null;
  }
}

function writeCachedLocation(file: string, location: WeatherLocation): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ ...location, guessedAt: Date.now() }, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing to clean up */
    }
  }
}

export interface WeatherServiceOptions {
  /** Where the city guess is cached (~/.pixel-agents by default). */
  dataDir: string;
  fetchJson?: FetchJson;
  pollIntervalMs?: number;
}

export class WeatherService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private location: WeatherLocation | null = null;
  private latest: Weather | null = null;
  private polling = false;
  /** Set by stop(): a poll still in flight then sends nothing. */
  private stopped = false;
  private readonly fetchJson: FetchJson;

  constructor(
    private readonly store: AgentStateStore,
    private readonly options: WeatherServiceOptions,
  ) {
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
  }

  /** Begin polling (now, then every 30 min). Idempotent. */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.poll();
    this.timer = setInterval(
      () => void this.poll(),
      this.options.pollIntervalMs ?? WEATHER_POLL_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The latest weather, for a client that connects (null: none yet / offline). */
  snapshot(): Weather | null {
    return this.latest ? { ...this.latest } : null;
  }

  /** One poll: the city (cached), then its current weather. Never throws. */
  async poll(): Promise<Weather | null> {
    if (this.polling) return null;
    this.polling = true;
    try {
      const location = await this.resolveLocation();
      if (!location || this.stopped) return null;
      const raw = await this.fetchJson(
        openMeteoUrl(location.latitude, location.longitude),
        WEATHER_REQUEST_TIMEOUT_MS,
      );
      const weather = parseOpenMeteo(raw, location.city);
      if (!weather || this.stopped) return null;
      this.latest = weather;
      this.store.broadcast({ ...weather });
      return weather;
    } catch {
      return null; // offline or a bad answer: no weather, silently
    } finally {
      this.polling = false;
    }
  }

  private async resolveLocation(): Promise<WeatherLocation | null> {
    if (this.location) return this.location;
    const file = path.join(this.options.dataDir, WEATHER_LOCATION_FILE_NAME);
    const cached = readCachedLocation(file);
    if (cached) return (this.location = cached);
    for (const url of WEATHER_IP_LOOKUP_URLS) {
      try {
        const guess = parseIpLocation(await this.fetchJson(url, WEATHER_REQUEST_TIMEOUT_MS));
        if (guess) {
          writeCachedLocation(file, guess);
          return (this.location = guess);
        }
      } catch {
        /* try the next lookup */
      }
    }
    return null;
  }
}
