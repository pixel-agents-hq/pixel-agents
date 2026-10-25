import type { TokenSpend } from '../../../core/src/messages.js';
import {
  TIER_COLOR_CODEX,
  TIER_COLOR_FABLE,
  TIER_COLOR_HAIKU,
  TIER_COLOR_OPUS,
  TIER_COLOR_SONNET,
  TIER_COLOR_UNKNOWN,
} from '../constants.js';

export const ModelTier = {
  HAIKU: 'haiku',
  SONNET: 'sonnet',
  OPUS: 'opus',
  FABLE: 'fable',
  CODEX: 'codex',
  UNKNOWN: 'unknown',
} as const;
export type ModelTier = (typeof ModelTier)[keyof typeof ModelTier];

export const TIER_LABELS: Record<Exclude<ModelTier, 'unknown'>, string> = {
  haiku: 'Haiku',
  sonnet: 'Sonnet',
  opus: 'Opus',
  fable: 'Fable',
  codex: 'Codex',
};

export const TIER_COLORS: Record<ModelTier, string> = {
  haiku: TIER_COLOR_HAIKU,
  sonnet: TIER_COLOR_SONNET,
  opus: TIER_COLOR_OPUS,
  fable: TIER_COLOR_FABLE,
  codex: TIER_COLOR_CODEX,
  unknown: TIER_COLOR_UNKNOWN,
};

/** Model families, checked in order against the lowercased model string. */
const MODEL_FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'] as const;

/** The cascade fields a character carries (all optional: updates are partial). */
export interface CascadeInsight {
  model?: string;
  agentType?: string;
  description?: string;
  effort?: string;
  thinking?: string;
  spend?: TokenSpend;
}

export interface CascadeState extends CascadeInsight {
  /** ms timestamp of the last time `thinking` changed. */
  thinkingAt?: number;
}

export function modelTier({ model, agentType }: { model?: string; agentType?: string }): ModelTier {
  const m = model?.toLowerCase() ?? '';
  if (agentType?.toLowerCase().includes('codex') || m.includes('codex')) return ModelTier.CODEX;
  for (const family of MODEL_FAMILIES) {
    if (m.includes(family)) return family;
  }
  return ModelTier.UNKNOWN;
}

/** `Sonnet · ecc:constructor · high`, missing parts omitted; null for an unknown tier. */
export function formatTierBadge(c: CascadeInsight): string | null {
  const tier = modelTier(c);
  if (tier === ModelTier.UNKNOWN) return null;
  return [TIER_LABELS[tier], c.agentType, c.effort].filter(Boolean).join(' · ');
}

/** First `maxChars` characters of the thinking text on one line, ellipsis when
 *  cut. Counts code points, so an emoji is never split in half. */
export function thoughtPreview(text: string, maxChars: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  const flat = chars.join('');
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : flat;
}

export function isThoughtFresh(c: CascadeState, now: number, windowMs: number): boolean {
  return !!c.thinking && c.thinkingAt !== undefined && now - c.thinkingAt < windowMs;
}

/** Fold a partial update into `target`: absent fields keep their value. */
export function applyInsight(target: CascadeState, patch: CascadeInsight, now: number): void {
  if (patch.model !== undefined) target.model = patch.model;
  if (patch.agentType !== undefined) target.agentType = patch.agentType;
  if (patch.description !== undefined) target.description = patch.description;
  if (patch.effort !== undefined) target.effort = patch.effort;
  if (patch.spend !== undefined) target.spend = patch.spend;
  if (patch.thinking !== undefined && patch.thinking !== target.thinking) {
    target.thinking = patch.thinking;
    target.thinkingAt = now;
  }
}

/** Insight held for a character that does not exist yet. `thinkingAt` is when
 *  the thinking arrived, so a late flush does not show an old thought as new. */
export interface PendingInsight extends CascadeInsight {
  thinkingAt?: number;
}

/**
 * Hold a partial update until its character exists. The entry moves to the
 * end (most recent), and the oldest entries beyond `max` are dropped: insight
 * for a character that never appears, or one already gone, must not pile up
 * over a long session.
 */
export function holdInsight<K>(
  held: Map<K, PendingInsight>,
  key: K,
  patch: CascadeInsight,
  now: number,
  max: number,
): void {
  const prev = held.get(key) ?? {};
  const next: PendingInsight = mergeInsight(prev, patch);
  next.thinkingAt = patch.thinking !== undefined ? now : prev.thinkingAt;
  held.delete(key);
  held.set(key, next);
  for (const oldest of held.keys()) {
    if (held.size <= max) break;
    held.delete(oldest);
  }
}

/** Combine two partial updates; `next` wins per field. */
export function mergeInsight(prev: CascadeInsight, next: CascadeInsight): CascadeInsight {
  const merged: CascadeInsight = { ...prev };
  for (const key of Object.keys(next) as Array<keyof CascadeInsight>) {
    if (next[key] !== undefined) (merged as Record<string, unknown>)[key] = next[key];
  }
  return merged;
}
