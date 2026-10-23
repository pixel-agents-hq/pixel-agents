import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { createHttpServer } from '../src/httpServer.js';
import {
  statusLineText,
  usageReportBody,
} from '../src/providers/hook/claude/hooks/claude-statusline.js';
import { parseRateLimits, percentText } from '../src/usage/rateLimits.js';
import { getUsageMeter, setUsageMeter, UsageMeter } from '../src/usage/usageMeter.js';

const NOW = 1_800_000_000_000; // epoch ms
const HOUR = 60 * 60 * 1000;
const sec = (ms: number) => Math.floor(ms / 1000);

/** A status line's rate_limits, resets in epoch seconds as Claude Code sends them. */
function rateLimits(five?: [number, number], seven?: [number, number]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (five) out.five_hour = { used_percentage: five[0], resets_at: sec(five[1]) };
  if (seven) out.seven_day = { used_percentage: seven[0], resets_at: sec(seven[1]) };
  return out;
}

describe('parseRateLimits', () => {
  it('reads both windows, converting resets_at from epoch seconds to ms', () => {
    expect(parseRateLimits(rateLimits([23.5, NOW + HOUR], [41, NOW + 50 * HOUR]), NOW)).toEqual({
      fiveHour: { usedPercentage: 23.5, resetsAt: NOW + HOUR },
      sevenDay: { usedPercentage: 41, resetsAt: NOW + 50 * HOUR },
    });
  });

  it('keeps a window present on its own', () => {
    expect(parseRateLimits(rateLimits(undefined, [8, NOW + HOUR]), NOW)).toEqual({
      sevenDay: { usedPercentage: 8, resetsAt: NOW + HOUR },
    });
  });

  it('is undefined for an API-key session, junk, or nothing usable', () => {
    expect(parseRateLimits(undefined, NOW)).toBeUndefined();
    expect(parseRateLimits({}, NOW)).toBeUndefined();
    expect(parseRateLimits('x', NOW)).toBeUndefined();
    expect(parseRateLimits({ five_hour: { used_percentage: '5', resets_at: 1 } }, NOW)).toBe(
      undefined,
    );
    expect(parseRateLimits({ five_hour: { used_percentage: 5 } }, NOW)).toBeUndefined();
  });

  it('drops a window that already reset', () => {
    expect(parseRateLimits(rateLimits([90, NOW - 1000], [10, NOW + HOUR]), NOW)).toEqual({
      sevenDay: { usedPercentage: 10, resetsAt: NOW + HOUR },
    });
  });

  it('clamps the percentage to 0-100', () => {
    const parsed = parseRateLimits(rateLimits([140, NOW + HOUR], [-3, NOW + HOUR]), NOW);
    expect(parsed?.fiveHour?.usedPercentage).toBe(100);
    expect(parsed?.sevenDay?.usedPercentage).toBe(0);
  });

  it('rounds the percentage text down', () => {
    expect(percentText(99.6)).toBe('99%');
    expect(percentText(0)).toBe('0%');
  });
});

describe('UsageMeter', () => {
  let store: AgentStateStore;
  let broadcasts: Array<Record<string, unknown>>;
  let now: number;
  let meter: UsageMeter;

  beforeEach(() => {
    vi.useFakeTimers();
    now = NOW;
    store = new AgentStateStore();
    broadcasts = [];
    store.on('broadcast', (m) => broadcasts.push(m));
    meter = new UsageMeter(store, { file: null, now: () => now });
  });

  afterEach(() => {
    meter.dispose();
    vi.useRealTimers();
  });

  it('has nothing to send before the first report', () => {
    expect(meter.snapshot()).toEqual([]);
  });

  it('broadcasts a report, and only when the numbers change', () => {
    const body = { rate_limits: rateLimits([20, NOW + HOUR], [5, NOW + 90 * HOUR]) };
    expect(meter.report(body)).toBe(true);
    expect(broadcasts).toEqual([
      {
        type: 'subscriptionUsage',
        fiveHour: { usedPercentage: 20, resetsAt: NOW + HOUR },
        sevenDay: { usedPercentage: 5, resetsAt: NOW + 90 * HOUR },
        updatedAt: NOW,
      },
    ]);
    meter.report(body);
    expect(broadcasts).toHaveLength(1);
    meter.report({ rate_limits: rateLimits([21, NOW + HOUR], [5, NOW + 90 * HOUR]) });
    expect(broadcasts).toHaveLength(2);
    expect(meter.snapshot()[0]?.fiveHour?.usedPercentage).toBe(21);
  });

  it('keeps a window a later report omits, until it resets', () => {
    meter.report({ rate_limits: rateLimits([20, NOW + HOUR], [5, NOW + 90 * HOUR]) });
    meter.report({ rate_limits: rateLimits([30, NOW + HOUR]) });
    expect(meter.snapshot()[0]).toMatchObject({
      fiveHour: { usedPercentage: 30 },
      sevenDay: { usedPercentage: 5 },
    });
  });

  it('ignores a report with no usable window', () => {
    expect(meter.report({ rate_limits: {} })).toBe(false);
    expect(meter.report(null)).toBe(false);
    expect(broadcasts).toEqual([]);
  });

  it('drops a window at its reset time and tells the office', () => {
    meter.report({ rate_limits: rateLimits([80, NOW + HOUR], [40, NOW + 90 * HOUR]) });
    now = NOW + HOUR + 1;
    vi.advanceTimersByTime(HOUR + 1);
    const last = broadcasts.at(-1);
    expect(last?.fiveHour).toBeUndefined();
    expect(last?.sevenDay).toEqual({ usedPercentage: 40, resetsAt: NOW + 90 * HOUR });
  });

  it('saves the last report and a new meter starts from it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-usage-'));
    const file = path.join(dir, 'usage.json');
    try {
      const saving = new UsageMeter(store, { file, now: () => now });
      saving.report({ rate_limits: rateLimits([33, NOW + HOUR], [7, NOW + 90 * HOUR]) });
      saving.dispose();
      // Later, after the 5-hour window reset: only the weekly cap survives.
      now = NOW + 2 * HOUR;
      const restored = new UsageMeter(store, { file, now: () => now });
      expect(restored.snapshot()).toEqual([
        {
          type: 'subscriptionUsage',
          sevenDay: { usedPercentage: 7, resetsAt: NOW + 90 * HOUR },
          updatedAt: NOW,
        },
      ]);
      restored.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts empty from an unreadable file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-usage-'));
    const file = path.join(dir, 'usage.json');
    try {
      fs.writeFileSync(file, '{not json');
      const restored = new UsageMeter(store, { file, now: () => now });
      expect(restored.snapshot()).toEqual([]);
      restored.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/usage', () => {
  it('reaches the registered meter with the Bearer token, and only with it', async () => {
    const store = new AgentStateStore();
    const meter = new UsageMeter(store, { file: null });
    setUsageMeter(meter);
    const broadcasts: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => broadcasts.push(m));
    const { app } = await createHttpServer({ embedded: true, token: 'secret', store });
    try {
      const future = Date.now() + HOUR;
      const payload = { rate_limits: rateLimits([12, future]) };
      const denied = await app.inject({ method: 'POST', url: '/api/usage', payload });
      expect(denied.statusCode).toBe(401);
      expect(broadcasts).toEqual([]);

      const ok = await app.inject({
        method: 'POST',
        url: '/api/usage',
        payload,
        headers: { authorization: 'Bearer secret' },
      });
      expect(ok.statusCode).toBe(200);
      expect(broadcasts[0]).toMatchObject({
        type: 'subscriptionUsage',
        fiveHour: { usedPercentage: 12 },
      });
    } finally {
      await app.close();
      meter.dispose();
      if (getUsageMeter() === meter) setUsageMeter(null);
    }
  });
});

describe('status line script', () => {
  const windows = {
    fiveHour: { usedPercentage: 23.5, resetsAt: NOW + HOUR },
    sevenDay: { usedPercentage: 41, resetsAt: NOW + 90 * HOUR },
  };

  it('prints the model, then the usage', () => {
    const text = statusLineText({ model: { display_name: 'Opus 5.5' } }, windows);
    expect(text).toMatch(/^Opus 5\.5 \| 5h 23% \(resets .+\) \| 7d 41%$/);
  });

  it('prints just the model without usage', () => {
    expect(statusLineText({ model: { display_name: 'Opus 5.5' } }, undefined)).toBe('Opus 5.5');
    expect(statusLineText({}, undefined)).toBe('');
  });

  it('forwards only the two windows, which the server parses back', () => {
    const body = JSON.parse(usageReportBody(windows)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['rate_limits']);
    expect(parseRateLimits(body.rate_limits, NOW)).toEqual(windows);
  });
});
