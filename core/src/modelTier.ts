/**
 * Model tiers of the cascade view, shared by server and webview: which family
 * a model id belongs to, and which tiers a Nakama can be drawn for.
 */

export const ModelTier = {
  HAIKU: 'haiku',
  SONNET: 'sonnet',
  OPUS: 'opus',
  FABLE: 'fable',
  CODEX: 'codex',
  UNKNOWN: 'unknown',
} as const;
export type ModelTier = (typeof ModelTier)[keyof typeof ModelTier];

/** Model families, checked in order against the lowercased model string. */
const MODEL_FAMILIES = [
  ModelTier.HAIKU,
  ModelTier.SONNET,
  ModelTier.OPUS,
  ModelTier.FABLE,
] as const;

/** The tiers a Nakama collection can be reserved for. */
export const NAKAMA_TIERS = MODEL_FAMILIES;
export type NakamaTier = (typeof NAKAMA_TIERS)[number];

export function modelTier({ model, agentType }: { model?: string; agentType?: string }): ModelTier {
  const m = model?.toLowerCase() ?? '';
  if (agentType?.toLowerCase().includes('codex') || m.includes('codex')) return ModelTier.CODEX;
  for (const family of MODEL_FAMILIES) {
    if (m.includes(family)) return family;
  }
  return ModelTier.UNKNOWN;
}

/** The Nakama tier for a model, or null when no collection can be reserved
 *  for it (Codex, unknown ids). */
export function nakamaTierOf(model: string | undefined): NakamaTier | null {
  const tier = modelTier({ model });
  return (NAKAMA_TIERS as readonly string[]).includes(tier) ? (tier as NakamaTier) : null;
}

export function isNakamaTier(value: unknown): value is NakamaTier {
  return typeof value === 'string' && (NAKAMA_TIERS as readonly string[]).includes(value);
}
