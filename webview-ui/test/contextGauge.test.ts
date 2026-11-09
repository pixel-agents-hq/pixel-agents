import { describe, expect, it } from 'vitest';

import {
  CONTEXT_GAUGE_COLOR_OK,
  CONTEXT_GAUGE_COLOR_RED,
  CONTEXT_GAUGE_COLOR_YELLOW,
} from '../src/constants.js';
import {
  agentContextUsed,
  clearAgentContextUsed,
  contextColor,
  contextLeft,
  contextUsedShare,
  setAgentContextUsed,
} from '../src/office/contextGauge.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

describe('contextColor', () => {
  it("steps like the user's status line: green under 33% used, yellow to 66%, red past it", () => {
    expect(contextColor(0.1)).toBe(CONTEXT_GAUGE_COLOR_OK);
    expect(contextColor(0.33)).toBe(CONTEXT_GAUGE_COLOR_YELLOW);
    expect(contextColor(0.66)).toBe(CONTEXT_GAUGE_COLOR_YELLOW);
    expect(contextColor(0.67)).toBe(CONTEXT_GAUGE_COLOR_RED);
  });
});

describe('contextLeft', () => {
  it('is the share left, never below empty', () => {
    expect(contextLeft(0)).toBe(1);
    expect(contextLeft(0.25)).toBe(0.75);
    expect(contextLeft(1)).toBe(0);
    expect(contextLeft(1.2)).toBe(0);
  });
});

describe('a cleared session (0 tokens)', () => {
  it('is a real reading: nothing used, a full gauge', () => {
    expect(contextUsedShare(0, 200_000)).toBe(0);
    expect(contextLeft(contextUsedShare(0, 200_000)!)).toBe(1);
    expect(contextUsedShare(300_000, 200_000)).toBe(1);
    expect(contextUsedShare(Number.NaN, 200_000)).toBeNull();
    expect(contextUsedShare(-1, 200_000)).toBeNull();
    expect(contextUsedShare(10, 0)).toBeNull();
  });

  it("drops the card's bar to a full one, not none", () => {
    setAgentContextUsed(41, 150_000, 200_000);
    expect(agentContextUsed(41)).toBe(0.75);
    setAgentContextUsed(41, 0, 200_000);
    expect(agentContextUsed(41)).toBe(0);
  });

  it('keeps the gauge over the character, full (contextReported)', () => {
    const cols = 4;
    const rows = 4;
    const layout: OfficeLayout = {
      version: 1,
      cols,
      rows,
      tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
      furniture: [],
    };
    const os = new OfficeState(layout);
    os.addAgent(1, undefined, undefined, undefined, true);
    expect(os.characters.get(1)!.contextReported).toBeFalsy();
    os.setAgentContext(1, 150_000, 200_000);
    os.setAgentContext(1, 0, 200_000);
    const ch = os.characters.get(1)!;
    expect(ch.contextReported).toBe(true);
    expect(ch.contextTokens).toBe(0);
  });
});

describe('closing an agent', () => {
  it("forgets its card's context", () => {
    setAgentContextUsed(42, 50_000, 200_000);
    clearAgentContextUsed(42);
    expect(agentContextUsed(42)).toBeNull();
  });
});
