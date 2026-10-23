import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resendAgentActivity } from '../src/agentActivityResend.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { weatherEnabled } from '../src/fun/funConstants.js';
import {
  conditionFromWmo,
  parseIpLocation,
  parseOpenMeteo,
  readCachedLocation,
  WeatherService,
} from '../src/fun/weather.js';
import {
  lastLocalDates,
  readWeekDay,
  weekDayFrom,
  WeekStatsTracker,
} from '../src/fun/weekStats.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';

/** Local noon on a date, as epoch ms. */
const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime();

function recorder(store: AgentStateStore): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  store.on('broadcast', (m: Record<string, unknown>) => sent.push(m));
  return sent;
}

describe('week stats', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-week-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const writeDay = (date: string, body: unknown) =>
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(body));

  it('lists the last 7 local dates, oldest first, across a month boundary', () => {
    expect(lastLocalDates(at(2026, 11, 3))).toEqual([
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
    ]);
  });

  it('sums PRs, pushes and active time from a daily file, ignoring junk', () => {
    expect(
      weekDayFrom('2026-10-01', {
        prs: [{ title: 'a' }, { title: 'b' }, 'junk'],
        pushes: [
          { repo: 'x', count: 2 },
          { repo: 'y', count: 3 },
          { repo: 'z', count: -1 },
        ],
        activeMs: 1234,
      }),
    ).toEqual({ date: '2026-10-01', prs: 2, pushes: 5, activeMs: 1234 });
    expect(readWeekDay(dir, '2020-01-01')).toEqual({
      date: '2020-01-01',
      prs: 0,
      pushes: 0,
      activeMs: 0,
    });
    fs.writeFileSync(path.join(dir, '2020-01-02.json'), '{not json');
    expect(readWeekDay(dir, '2020-01-02').prs).toBe(0);
  });

  it('builds the week from past files plus the live dailyStats, and resends only on change', () => {
    writeDay('2026-10-14', { prs: [{}], pushes: [{ repo: 'a', count: 1 }], activeMs: 10 });
    writeDay('2026-10-17', { prs: [{}, {}], pushes: [], activeMs: 20 });
    const store = new AgentStateStore();
    const sent = recorder(store);
    const week = new WeekStatsTracker(store, { dailyDir: dir, now: () => at(2026, 10, 18) });

    const snap = week.snapshot();
    expect(snap.type).toBe('weekStats');
    expect(snap.days.map((d) => d.date)).toEqual(lastLocalDates(at(2026, 10, 18)));
    expect(snap.days.find((d) => d.date === '2026-10-14')).toMatchObject({ prs: 1, pushes: 1 });
    expect(snap.days.find((d) => d.date === '2026-10-17')).toMatchObject({ prs: 2 });

    const daily = {
      type: 'dailyStats',
      date: '2026-10-18',
      prs: [{ title: 't', repo: 'r', at: 1 }],
      pushes: [{ repo: 'r', count: 4 }],
      filesEdited: 0,
      commandsRun: 0,
      activeMs: 99,
    };
    store.broadcast(daily);
    const weeks = sent.filter((m) => m.type === 'weekStats');
    expect(weeks).toHaveLength(1);
    const days = weeks[0].days as Array<{ date: string; prs: number; pushes: number }>;
    expect(days[6]).toEqual({ date: '2026-10-18', prs: 1, pushes: 4, activeMs: 99 });

    // Same totals again (e.g. a files-edited change): no new weekStats.
    store.broadcast({ ...daily, filesEdited: 3 });
    expect(sent.filter((m) => m.type === 'weekStats')).toHaveLength(1);
    week.dispose();
  });

  it('is part of the connect-time resend', () => {
    const store = new AgentStateStore();
    const runtime = new AgentRuntime(store, claudeProvider, { progress: { dailyDir: dir } });
    const sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((m) => sent.push(m), store);
    expect(sent.some((m) => m.type === 'weekStats')).toBe(true);
    // No weather before a successful poll.
    expect(sent.some((m) => m.type === 'weather')).toBe(false);
    runtime.dispose();
  });
});

describe('weather', () => {
  it('maps WMO codes to window conditions', () => {
    expect(conditionFromWmo(0)).toBe('clear');
    expect(conditionFromWmo(1)).toBe('clear');
    expect(conditionFromWmo(2)).toBe('clouds');
    expect(conditionFromWmo(3)).toBe('clouds');
    expect(conditionFromWmo(45)).toBe('fog');
    expect(conditionFromWmo(48)).toBe('fog');
    expect(conditionFromWmo(53)).toBe('rain');
    expect(conditionFromWmo(65)).toBe('rain');
    expect(conditionFromWmo(81)).toBe('rain');
    expect(conditionFromWmo(73)).toBe('snow');
    expect(conditionFromWmo(86)).toBe('snow');
    expect(conditionFromWmo(95)).toBe('storm');
    expect(conditionFromWmo(99)).toBe('storm');
  });

  it('parses both IP lookups and rejects failures', () => {
    expect(parseIpLocation({ city: 'Jaipur', latitude: 26.9, longitude: 75.8 })).toEqual({
      city: 'Jaipur',
      latitude: 26.9,
      longitude: 75.8,
    });
    expect(parseIpLocation({ status: 'success', city: 'Pune', lat: 18.5, lon: 73.8 })).toEqual({
      city: 'Pune',
      latitude: 18.5,
      longitude: 73.8,
    });
    expect(parseIpLocation({ error: true, reason: 'RateLimited' })).toBeNull();
    expect(parseIpLocation({ status: 'fail' })).toBeNull();
    expect(parseIpLocation({ city: 'x', latitude: 200, longitude: 0 })).toBeNull();
    expect(parseIpLocation('nope')).toBeNull();
  });

  it('parses Open-Meteo current weather', () => {
    expect(
      parseOpenMeteo({ current: { temperature_2m: 22.94, weather_code: 61, is_day: 0 } }, 'Jaipur'),
    ).toEqual({ type: 'weather', condition: 'rain', isDay: false, tempC: 22.9, city: 'Jaipur' });
    expect(parseOpenMeteo({ current: { temperature_2m: 'hot' } }, 'x')).toBeNull();
    expect(parseOpenMeteo(null, 'x')).toBeNull();
  });

  it('guesses the city once, caches it, and broadcasts the weather', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-weather-'));
    try {
      const store = new AgentStateStore();
      const sent = recorder(store);
      const urls: string[] = [];
      const fetchJson = async (url: string): Promise<unknown> => {
        urls.push(url);
        if (url.includes('ipapi.co')) throw new Error('rate limited');
        if (url.includes('ip-api.com'))
          return { status: 'success', city: 'Jaipur', lat: 26.9, lon: 75.8 };
        return { current: { temperature_2m: 5, weather_code: 71, is_day: 1 } };
      };
      const weather = new WeatherService(store, { dataDir, fetchJson });
      const first = await weather.poll();
      expect(first).toEqual({
        type: 'weather',
        condition: 'snow',
        isDay: true,
        tempC: 5,
        city: 'Jaipur',
      });
      expect(sent.filter((m) => m.type === 'weather')).toHaveLength(1);
      expect(weather.snapshot()).toEqual(first);
      expect(readCachedLocation(path.join(dataDir, 'weather-location.json'))?.city).toBe('Jaipur');

      // A fresh service reads the cache instead of looking the IP up again.
      urls.length = 0;
      const again = new WeatherService(store, { dataDir, fetchJson });
      await again.poll();
      expect(urls.some((u) => u.includes('ip'))).toBe(false);
      expect(urls.some((u) => u.includes('open-meteo'))).toBe(true);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('stays silent offline', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-weather-'));
    try {
      const store = new AgentStateStore();
      const sent = recorder(store);
      const weather = new WeatherService(store, {
        dataDir,
        fetchJson: async () => {
          throw new Error('offline');
        },
      });
      expect(await weather.poll()).toBeNull();
      expect(sent).toHaveLength(0);
      expect(weather.snapshot()).toBeNull();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('can be switched off by env', () => {
    expect(weatherEnabled({})).toBe(true);
    expect(weatherEnabled({ PIXEL_AGENTS_WEATHER: 'off' })).toBe(false);
    expect(weatherEnabled({ PIXEL_AGENTS_WEATHER: '0' })).toBe(false);
  });
});
