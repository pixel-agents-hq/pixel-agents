import { describe, expect, it } from 'vitest';

import {
  describeShape,
  formatStatusLine,
  mergeUsage,
  parseStatusInput,
  toSessionSnapshot,
  toUsageSnapshot,
} from '../src/providers/hook/claude/statusline/statusLine.js';

// 2026-10-25T21:40:00Z and 2026-10-26T09:00:00Z (a Monday) as epoch seconds.
const FIVE_HOUR_RESET = Date.UTC(2026, 9, 25, 21, 40) / 1000;
const SEVEN_DAY_RESET = Date.UTC(2026, 9, 26, 9, 0) / 1000;
const NOW = Date.UTC(2026, 9, 25, 19, 0);

function fullPayload(): Record<string, unknown> {
  return {
    hook_event_name: 'Status',
    session_id: 'e09b1d74-5cf8-49ee-919b-f15749caa047',
    transcript_path: 'C:\\Users\\x\\.claude\\projects\\p\\e09b1d74.jsonl',
    cwd: 'C:\\Users\\x\\repo',
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    workspace: { current_dir: 'C:\\Users\\x\\repo', project_dir: 'C:\\Users\\x\\repo' },
    version: '2.1.310',
    session_name: 'nakama consola',
    effort: { level: 'xhigh' },
    thinking: { enabled: true },
    fast_mode: false,
    prompt_cache: {
      warm: true,
      ttl: '1h',
      expires_at: FIVE_HOUR_RESET,
      requests: 40,
      misses: 2,
      hit_ratio: 0.95,
    },
    cost: {
      total_cost_usd: 1.234,
      total_duration_ms: 60_000,
      total_lines_added: 10,
      total_lines_removed: 2,
    },
    context_window: { used_percentage: 34.4, context_window_size: 1_000_000 },
    rate_limits: {
      five_hour: { used_percentage: 62.2, resets_at: FIVE_HOUR_RESET },
      seven_day: { used_percentage: 18, resets_at: SEVEN_DAY_RESET },
    },
  };
}

const UTC = { timeZone: 'UTC', color: false };

const PROMPT_CACHE = {
  warm: true,
  ttl: '1h',
  expiresAt: FIVE_HOUR_RESET,
  requests: 40,
  misses: 2,
  hitRatio: 0.95,
};

describe('parseStatusInput', () => {
  it('reads the fields the session bar needs', () => {
    const input = parseStatusInput(fullPayload());
    expect(input).not.toBeNull();
    expect(input?.sessionId).toBe('e09b1d74-5cf8-49ee-919b-f15749caa047');
    expect(input?.model).toEqual({ id: 'claude-opus-5-5', displayName: 'Opus 5.5' });
    expect(input?.contextUsedPct).toBe(34.4);
    expect(input?.fiveHour).toEqual({ usedPct: 62.2, resetsAt: FIVE_HOUR_RESET });
    expect(input?.sevenDay).toEqual({ usedPct: 18, resetsAt: SEVEN_DAY_RESET });
    expect(input?.costUsd).toBe(1.234);
    expect(input?.effort).toBe('xhigh');
    expect(input?.sessionName).toBe('nakama consola');
    expect(input?.promptCache).toEqual(PROMPT_CACHE);
    expect(input?.thinkingEnabled).toBe(true);
    expect(input?.fastMode).toBe(false);
  });

  it('returns null for anything that is not an object', () => {
    expect(parseStatusInput(null)).toBeNull();
    expect(parseStatusInput('hola')).toBeNull();
    expect(parseStatusInput([1, 2])).toBeNull();
  });

  it('treats missing or malformed rate limits as unknown, not zero', () => {
    const payload = fullPayload();
    delete payload['rate_limits'];
    expect(parseStatusInput(payload)?.fiveHour).toBeUndefined();

    const bad = fullPayload();
    bad['rate_limits'] = { five_hour: { used_percentage: 'mucho' } };
    expect(parseStatusInput(bad)?.fiveHour).toBeUndefined();
  });

  it('drops a session id that could escape the snapshot folder', () => {
    for (const id of ['../../evil', 'a/b', 'a\\b', '', 'x'.repeat(200)]) {
      const payload = { ...fullPayload(), session_id: id };
      expect(parseStatusInput(payload)?.sessionId).toBeUndefined();
    }
  });
});

describe('formatStatusLine', () => {
  it('shows model, context, both limits with their reset time, and spend', () => {
    const line = formatStatusLine(parseStatusInput(fullPayload())!, NOW, UTC);
    expect(line).toBe(
      'Opus 5.5 xhigh · ctx 34% · 5h ▰▰▰▱▱ 62% ↺21:40 · 7d ▰▱▱▱▱ 18% ↺lun 09:00 · $1.23',
    );
  });

  it('marks the limits as unknown before the first response', () => {
    const payload = fullPayload();
    delete payload['rate_limits'];
    const line = formatStatusLine(parseStatusInput(payload)!, NOW, UTC);
    expect(line).toBe('Opus 5.5 xhigh · ctx 34% · 5h — · 7d — · $1.23');
  });

  it('colors a limit red at 80% and over', () => {
    const payload = fullPayload();
    (payload['rate_limits'] as Record<string, unknown>)['five_hour'] = {
      used_percentage: 85,
      resets_at: FIVE_HOUR_RESET,
    };
    const line = formatStatusLine(parseStatusInput(payload)!, NOW, {
      timeZone: 'UTC',
      color: true,
    });
    expect(line).toContain('\u001b[31m5h ▰▰▰▰▱ 85%');
  });

  it('still prints something useful from an empty object', () => {
    expect(formatStatusLine(parseStatusInput({})!, NOW, UTC)).toBe('Nakama · 5h — · 7d —');
  });
});

describe('snapshots written for Nakama', () => {
  it('keeps only usage numbers and session identity, never paths to transcripts', () => {
    const snap = toSessionSnapshot(parseStatusInput(fullPayload())!, NOW);
    expect(snap).toEqual({
      v: 1,
      sessionId: 'e09b1d74-5cf8-49ee-919b-f15749caa047',
      updatedAt: NOW,
      model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
      sessionName: 'nakama consola',
      effort: 'xhigh',
      thinkingEnabled: true,
      fastMode: false,
      promptCache: PROMPT_CACHE,
      cwd: 'C:\\Users\\x\\repo',
      contextUsedPct: 34.4,
      contextWindowSize: 1_000_000,
      costUsd: 1.234,
      durationMs: 60_000,
      linesAdded: 10,
      linesRemoved: 2,
      fiveHour: { usedPct: 62.2, resetsAt: FIVE_HOUR_RESET },
      sevenDay: { usedPct: 18, resetsAt: SEVEN_DAY_RESET },
    });
    expect(JSON.stringify(snap)).not.toContain('jsonl');
  });

  it('has no session snapshot without a safe session id', () => {
    const payload = { ...fullPayload(), session_id: '../x' };
    expect(toSessionSnapshot(parseStatusInput(payload)!, NOW)).toBeNull();
  });

  it('writes the account-wide usage only when the limits are known', () => {
    expect(toUsageSnapshot(parseStatusInput(fullPayload())!, NOW)).toEqual({
      v: 1,
      updatedAt: NOW,
      sessionId: 'e09b1d74-5cf8-49ee-919b-f15749caa047',
      fiveHour: { usedPct: 62.2, resetsAt: FIVE_HOUR_RESET },
      sevenDay: { usedPct: 18, resetsAt: SEVEN_DAY_RESET },
    });
    const payload = fullPayload();
    delete payload['rate_limits'];
    expect(toUsageSnapshot(parseStatusInput(payload)!, NOW)).toBeNull();
  });
});

describe('hostile or drifting payloads never break the line', () => {
  it('omits a reset time that is not a real date instead of throwing', () => {
    const payload = fullPayload();
    (payload['rate_limits'] as Record<string, unknown>)['five_hour'] = {
      used_percentage: 40,
      resets_at: 1e14,
    };
    const input = parseStatusInput(payload)!;
    expect(() => formatStatusLine(input, NOW, UTC)).not.toThrow();
    expect(formatStatusLine(input, NOW, UTC)).toContain('5h ▰▰▱▱▱ 40% ·');
  });

  it('rejects Windows device names as session ids', () => {
    for (const id of ['CON', 'nul', 'Com1', 'LPT9']) {
      expect(parseStatusInput({ session_id: id })?.sessionId).toBeUndefined();
    }
  });

  it('fills at least one cell for any usage above zero', () => {
    const payload = fullPayload();
    (payload['rate_limits'] as Record<string, unknown>)['five_hour'] = { used_percentage: 3 };
    expect(formatStatusLine(parseStatusInput(payload)!, NOW, UTC)).toContain('5h ▰▱▱▱▱ 3%');
  });
});

describe('mergeUsage', () => {
  const A = { usedPct: 62, resetsAt: 1000 };

  it('takes the first reading as is', () => {
    expect(mergeUsage(null, { v: 1, updatedAt: 5, fiveHour: A })).toEqual({
      v: 1,
      updatedAt: 5,
      fiveHour: A,
    });
  });

  it('never moves a window backwards when an idle console repeats an old reading', () => {
    const prev = { v: 1 as const, updatedAt: 5, fiveHour: { usedPct: 70, resetsAt: 1000 } };
    const merged = mergeUsage(prev, { v: 1, updatedAt: 9, fiveHour: A });
    expect(merged.fiveHour).toEqual({ usedPct: 70, resetsAt: 1000 });
  });

  it('starts over when the window has reset', () => {
    const prev = { v: 1 as const, updatedAt: 5, fiveHour: { usedPct: 90, resetsAt: 1000 } };
    const next = { usedPct: 4, resetsAt: 19000 };
    expect(mergeUsage(prev, { v: 1, updatedAt: 9, fiveHour: next }).fiveHour).toEqual(next);
  });

  it('ignores a reading from a window that already ended', () => {
    const prev = { v: 1 as const, updatedAt: 5, fiveHour: { usedPct: 4, resetsAt: 19000 } };
    expect(mergeUsage(prev, { v: 1, updatedAt: 9, fiveHour: A }).fiveHour).toEqual({
      usedPct: 4,
      resetsAt: 19000,
    });
  });

  it('keeps the window the new reading does not carry', () => {
    const prev = { v: 1 as const, updatedAt: 5, sevenDay: { usedPct: 18, resetsAt: 9000 } };
    const merged = mergeUsage(prev, { v: 1, updatedAt: 9, fiveHour: A });
    expect(merged).toEqual({
      v: 1,
      updatedAt: 9,
      fiveHour: A,
      sevenDay: { usedPct: 18, resetsAt: 9000 },
    });
  });
});

describe('describeShape', () => {
  it('caps how many keys of one object it records', () => {
    const wide = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i]));
    const shape = describeShape(wide) as Record<string, unknown>;
    expect(Object.keys(shape).length).toBeLessThanOrEqual(51);
    expect(shape['…']).toBe('30 more');
  });

  it('records key names and value types, never the values', () => {
    const shape = describeShape({ a: 'secreto', b: { c: 3, d: [1] }, e: null });
    expect(shape).toEqual({ a: 'string', b: { c: 'number', d: 'array' }, e: 'null' });
    expect(JSON.stringify(shape)).not.toContain('secreto');
  });
});
