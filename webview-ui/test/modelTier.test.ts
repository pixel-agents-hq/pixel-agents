import { describe, expect, it } from 'vitest';

import {
  applyInsight,
  formatTierBadge,
  holdInsight,
  isThoughtFresh,
  mergeInsight,
  modelTier,
  type PendingInsight,
  thoughtBubbleText,
  thoughtPreview,
  TIER_LABELS,
} from '../src/office/modelTier.js';

describe('modelTier', () => {
  it('reads the family from an alias or a resolved id', () => {
    expect(modelTier({ model: 'haiku' })).toBe('haiku');
    expect(modelTier({ model: 'claude-haiku-5-5' })).toBe('haiku');
    expect(modelTier({ model: 'Claude-Sonnet-5-5' })).toBe('sonnet');
    expect(modelTier({ model: 'claude-opus-5' })).toBe('opus');
    expect(modelTier({ model: 'fable' })).toBe('fable');
  });

  it('agentType containing codex wins over the model, case-insensitively', () => {
    expect(modelTier({ model: 'claude-opus-5', agentType: 'Codex' })).toBe('codex');
    expect(modelTier({ agentType: 'ecc:codex-reviewer' })).toBe('codex');
  });

  it('is unknown when nothing matches', () => {
    expect(modelTier({})).toBe('unknown');
    expect(modelTier({ model: 'gpt-9', agentType: 'ecc:constructor' })).toBe('unknown');
  });

  it('labels every tier', () => {
    expect(TIER_LABELS.sonnet).toBe('Sonnet');
    expect(TIER_LABELS.codex).toBe('Codex');
  });
});

describe('formatTierBadge', () => {
  it('joins label, agent type and effort, omitting missing parts', () => {
    expect(formatTierBadge({ model: 'sonnet', agentType: 'ecc:constructor', effort: 'high' })).toBe(
      'Sonnet · ecc:constructor · high',
    );
    expect(formatTierBadge({ model: 'opus' })).toBe('Opus');
    expect(formatTierBadge({ model: 'haiku', effort: 'low' })).toBe('Haiku · low');
  });

  it('is null for an unknown tier', () => {
    expect(formatTierBadge({ agentType: 'ecc:constructor' })).toBeNull();
  });
});

describe('thought helpers', () => {
  it('previews the first N chars with an ellipsis and collapsed whitespace', () => {
    expect(thoughtPreview('  hola\n  mundo ', 90)).toBe('hola mundo');
    expect(thoughtPreview('abcdefghij', 4)).toBe('abcd…');
    expect(thoughtPreview('abcd', 4)).toBe('abcd');
  });

  it('is fresh only inside the window', () => {
    expect(isThoughtFresh({ thinking: 'x', thinkingAt: 1000 }, 1500, 600)).toBe(true);
    expect(isThoughtFresh({ thinking: 'x', thinkingAt: 1000 }, 1600, 600)).toBe(false);
    expect(isThoughtFresh({ thinking: '', thinkingAt: 1000 }, 1100, 600)).toBe(false);
    expect(isThoughtFresh({}, 1100, 600)).toBe(false);
  });
});

describe('applyInsight / mergeInsight', () => {
  it('absent fields keep their previous value; the latest model wins', () => {
    const ch: Parameters<typeof applyInsight>[0] = {};
    applyInsight(ch, { model: 'haiku', effort: 'low' }, 10);
    applyInsight(ch, { model: 'claude-haiku-5-5', thinking: 'pienso' }, 20);
    expect(ch.model).toBe('claude-haiku-5-5');
    expect(ch.effort).toBe('low');
    expect(ch.thinking).toBe('pienso');
    expect(ch.thinkingAt).toBe(20);
  });

  it('only bumps thinkingAt when the thinking text changes', () => {
    const ch: Parameters<typeof applyInsight>[0] = {};
    applyInsight(ch, { thinking: 'a' }, 10);
    applyInsight(ch, { thinking: 'a' }, 20);
    applyInsight(ch, { agentType: 'x' }, 30);
    expect(ch.thinkingAt).toBe(10);
    applyInsight(ch, { thinking: 'b' }, 40);
    expect(ch.thinkingAt).toBe(40);
  });

  it('merges pending partials with the later one winning per field', () => {
    expect(mergeInsight({ model: 'haiku', effort: 'low' }, { model: 'x', thinking: 't' })).toEqual({
      model: 'x',
      effort: 'low',
      thinking: 't',
    });
  });
});

describe('codex and preview edge cases', () => {
  it('reads Codex from the model id too, not only the agent type', () => {
    expect(modelTier({ model: 'gpt-5-codex' })).toBe('codex');
    expect(formatTierBadge({ model: 'gpt-5-codex' })).toBe('Codex');
  });

  it('never splits an emoji when cutting the preview', () => {
    expect(thoughtPreview('ab😀cd', 3)).toBe('ab😀…');
  });
});

describe('holdInsight', () => {
  it('stamps thinking when it arrives, so a late flush does not look fresh', () => {
    const held = new Map<number, PendingInsight>();
    holdInsight(held, 1, { thinking: 'old thought' }, 1_000, 64);
    holdInsight(
      held,
      1,
      { spend: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } },
      9_000,
      64,
    );
    const entry = held.get(1)!;
    expect(entry.thinkingAt).toBe(1_000);

    const ch: Parameters<typeof applyInsight>[0] = {};
    applyInsight(ch, entry, entry.thinkingAt ?? 9_000);
    expect(isThoughtFresh(ch, 9_000, 6_000)).toBe(false);
  });

  it('keeps at most `max` entries, evicting the least recently updated', () => {
    const held = new Map<string, PendingInsight>();
    holdInsight(held, 'a', { model: 'haiku' }, 1, 2);
    holdInsight(held, 'b', { model: 'sonnet' }, 2, 2);
    holdInsight(held, 'a', { effort: 'low' }, 3, 2);
    holdInsight(held, 'c', { model: 'opus' }, 4, 2);
    expect([...held.keys()]).toEqual(['a', 'c']);
    expect(held.get('a')).toMatchObject({ model: 'haiku', effort: 'low' });
  });
});

describe('thoughtBubbleText', () => {
  const fresh = { thinking: 'a  plan\nto follow', thinkingAt: 1000 };

  it('shows the flattened, cut thought while it is fresh and thinking is on', () => {
    expect(thoughtBubbleText(fresh, true, 1500, 5000, 100)).toBe('a plan to follow');
    expect(thoughtBubbleText(fresh, true, 1500, 5000, 6)).toBe('a plan…');
  });

  it('shows nothing when thinking is off, however fresh the thought', () => {
    expect(thoughtBubbleText(fresh, false, 1500, 5000, 100)).toBeNull();
  });

  it('shows nothing when stale or cleared', () => {
    expect(thoughtBubbleText(fresh, true, 7000, 5000, 100)).toBeNull();
    expect(thoughtBubbleText({ thinking: '', thinkingAt: 1000 }, true, 1500, 5000, 100)).toBeNull();
  });
});
