import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DailyTokens } from '../../core/src/messages.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { messageCostUsd, normalizeModelId, PRICES_CHECKED } from '../src/signals/pricing.js';
import { TokenMeter } from '../src/signals/tokenMeter.js';
import { processTranscriptLine } from '../src/transcriptParser.js';

/**
 * The spend/token meter: today's usage from transcript assistant records, one
 * count per API response, persisted per day in a temp dir (never the real
 * ~/.pixel-agents), with a list-price estimate.
 */

const T0 = new Date(2026, 9, 18, 10, 0, 0).getTime();
const TODAY = '2026-10-18';
const isoAt = (t: number) => new Date(t).toISOString();

function assistant(
  id: string,
  usage: Record<string, unknown>,
  model = 'claude-opus-5-5',
  at = T0,
): Record<string, unknown> {
  return {
    type: 'assistant',
    timestamp: isoAt(at),
    message: { id, model, usage, content: [{ type: 'text', text: 'hi' }] },
  };
}

describe('pricing', () => {
  it('normalizes transcript model ids to the table form', () => {
    expect(normalizeModelId('claude-opus-4-1-20250805')).toBe('claude-opus-4-1');
    expect(normalizeModelId('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(
      'claude-sonnet-4-5',
    );
    expect(normalizeModelId('claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
    expect(normalizeModelId('claude-opus-4-5@20251101')).toBe('claude-opus-4-5');
    expect(normalizeModelId('claude-3-5-haiku-20241022')).toBe('claude-3-5-haiku');
  });

  it('prices every category, and nothing it cannot place', () => {
    const tokens = {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite5m: 1_000_000,
      cacheWrite1h: 1_000_000,
    };
    // Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 / $8 cache writes.
    expect(messageCostUsd('claude-opus-5-5', tokens)).toBeCloseTo(4 + 20 + 0.2 + 5 + 8);
    expect(messageCostUsd('claude-opus-5-5', { ...tokens, fast: true })).toBeCloseTo(
      2 * (4 + 20 + 0.2 + 5 + 8),
    );
    expect(messageCostUsd('claude-unknown-9', tokens)).toBeUndefined();
    expect(PRICES_CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('prices a long Haiku 5.5 prompt at the higher tier', () => {
    const short = { input: 50_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    const long = { ...short, cacheRead: 60_000 };
    expect(messageCostUsd('claude-haiku-5-5', short)).toBeCloseTo((50_000 * 0.1) / 1e6);
    expect(messageCostUsd('claude-haiku-5-5', long)).toBeCloseTo(
      (50_000 * 0.5 + 60_000 * 0.05) / 1e6,
    );
  });
});

describe('TokenMeter', () => {
  let dir: string;
  let clock: number;
  let changes: DailyTokens[];

  const meter = () => new TokenMeter({ dir, now: () => clock, onChange: (m) => changes.push(m) });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-tokens-'));
    clock = T0;
    changes = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('counts one API response once, at its largest figures', () => {
    const m = meter();
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 200,
    };
    expect(m.record(assistant('msg_1', usage))).toBe(true);
    // The same response's next content block repeats the usage: no change.
    expect(m.record(assistant('msg_1', usage))).toBe(false);
    // A later block reports more output: only the difference counts.
    expect(m.record(assistant('msg_1', { ...usage, output_tokens: 50 }))).toBe(true);
    m.record(assistant('msg_2', { input_tokens: 1, output_tokens: 1 }));
    expect(m.message()).toMatchObject({
      type: 'dailyTokens',
      date: TODAY,
      input: 11,
      output: 51,
      cacheRead: 1000,
      cacheWrite: 200,
      byModel: { 'claude-opus-5-5': { input: 11, output: 51, cacheRead: 1000, cacheWrite: 200 } },
    });
    expect(changes).toHaveLength(3);
    m.dispose();
  });

  it('estimates spend, split by the 5-minute and 1-hour cache writes', () => {
    const m = meter();
    m.record(
      assistant('msg_1', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 2_000_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 1_000_000,
          ephemeral_1h_input_tokens: 1_000_000,
        },
      }),
    );
    expect(m.message().estimatedUsd).toBeCloseTo(4 + 20 + 0.2 + 5 + 8);
    expect(m.message().partialEstimate).toBeUndefined();
    m.dispose();
  });

  it('marks the estimate partial when a model has no price, and gives none when nothing has', () => {
    const m = meter();
    m.record(assistant('msg_1', { input_tokens: 100 }, 'claude-mystery-1'));
    expect(m.message().estimatedUsd).toBeUndefined();
    expect(m.message().byModel['claude-mystery-1']).toEqual({
      input: 100,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    m.record(assistant('msg_2', { input_tokens: 1_000_000 }));
    expect(m.message()).toMatchObject({ estimatedUsd: 4, partialEstimate: true });
    m.dispose();
  });

  it('skips synthetic records, zero usage, other record types and other days', () => {
    const m = meter();
    expect(m.record(assistant('msg_s', { input_tokens: 5 }, '<synthetic>'))).toBe(false);
    expect(m.record(assistant('msg_z', { input_tokens: 0, output_tokens: 0 }))).toBe(false);
    expect(m.record({ type: 'user', message: { id: 'x', usage: { input_tokens: 5 } } })).toBe(
      false,
    );
    const yesterday = T0 - 24 * 3600_000;
    expect(m.record(assistant('msg_y', { input_tokens: 5 }, 'claude-opus-5-5', yesterday))).toBe(
      false,
    );
    expect(m.message().input).toBe(0);
    m.dispose();
  });

  it('survives a restart without counting a re-read transcript twice', () => {
    const first = meter();
    first.record(assistant('msg_1', { input_tokens: 10, output_tokens: 20 }));
    first.dispose();
    const file = path.join(dir, `${TODAY}.json`);
    expect(fs.existsSync(file)).toBe(true);
    // Only counts and ids on disk.
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('hi');

    const second = meter();
    expect(second.record(assistant('msg_1', { input_tokens: 10, output_tokens: 20 }))).toBe(false);
    expect(second.message()).toMatchObject({ input: 10, output: 20 });
    second.dispose();
  });

  it('starts a fresh day after midnight', () => {
    const m = meter();
    m.record(assistant('msg_1', { input_tokens: 10 }));
    clock = T0 + 24 * 3600_000;
    expect(m.message()).toMatchObject({ date: '2026-10-19', input: 0 });
    m.dispose();
  });
});

describe('token meter wiring', () => {
  it('reads usage from every transcript line, and sends dailyTokens on connect', async () => {
    const { resendAgentActivity } = await import('../src/agentActivityResend.js');
    const store = new AgentStateStore();
    const runtime = new AgentRuntime(store, claudeProvider, {
      progress: { dailyDir: null },
      signals: { tokensDir: null, noticeBoard: null, now: () => T0 },
    });
    try {
      const agent = createAgentState({
        id: 1,
        sessionId: 's1',
        projectDir: '/w',
        jsonlFile: '',
        isExternal: true,
      });
      store.set(1, agent);
      const broadcasts: Record<string, unknown>[] = [];
      store.on('broadcast', (m) => broadcasts.push(m));
      processTranscriptLine(
        1,
        JSON.stringify(assistant('msg_1', { input_tokens: 3, output_tokens: 4 })),
        store,
        runtime.waitingTimers,
        runtime.permissionTimers,
      );
      expect(broadcasts.filter((m) => m.type === 'dailyTokens').at(-1)).toMatchObject({
        input: 3,
        output: 4,
      });
      const sent: Record<string, unknown>[] = [];
      resendAgentActivity((m) => sent.push(m), store);
      expect(sent.find((m) => m.type === 'dailyTokens')).toMatchObject({ input: 3, output: 4 });
    } finally {
      runtime.dispose();
    }
  });
});
