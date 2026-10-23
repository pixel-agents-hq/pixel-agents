/**
 * List prices for the spend estimate on the TODAY strip ("~$3.40 est.").
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing (Anthropic
 * first-party API rates, USD per million tokens), checked 2026-10-18. Update the
 * table and PRICES_CHECKED together. Claude Code on a subscription is not billed
 * per token, which is why the UI always labels the figure "est.".
 *
 * A model the table can't place gets no estimate (never a guess).
 */

export const PRICES_CHECKED = '2026-10-18';

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  /** 5-minute cache write. */
  cacheWrite5m: number;
  /** 1-hour cache write. */
  cacheWrite1h: number;
  /** Cache hits and refreshes. */
  cacheRead: number;
  output: number;
}

interface PriceRow {
  /** Normalized model ids this row prices (see normalizeModelId). */
  ids: string[];
  price: ModelPrice;
  /** Claude Haiku 5.5: a request whose prompt (input + cache reads + cache
   *  writes) is over `overTokens` pays `price` instead. */
  longPrompt?: { overTokens: number; price: ModelPrice };
  /** Fast mode (usage.speed "fast") multiplies every category by this. */
  fastMultiplier?: number;
}

const p = (
  input: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  cacheRead: number,
  output: number,
): ModelPrice => ({ input, cacheWrite5m, cacheWrite1h, cacheRead, output });

const PRICE_ROWS: PriceRow[] = [
  { ids: ['claude-fable-5-1', 'claude-mythos-5-1'], price: p(10, 12.5, 20, 0.25, 50) },
  { ids: ['claude-fable-5', 'claude-mythos-5'], price: p(10, 12.5, 20, 1, 50) },
  { ids: ['claude-opus-5-5'], price: p(4, 5, 8, 0.2, 20), fastMultiplier: 2 },
  { ids: ['claude-opus-5'], price: p(5, 6.25, 10, 0.5, 25), fastMultiplier: 2 },
  { ids: ['claude-opus-4-8'], price: p(5, 6.25, 10, 0.5, 25), fastMultiplier: 2 },
  {
    ids: ['claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5'],
    price: p(5, 6.25, 10, 0.5, 25),
  },
  {
    ids: ['claude-opus-4-1', 'claude-opus-4', 'claude-opus-4-0'],
    price: p(15, 18.75, 30, 1.5, 75),
  },
  { ids: ['claude-sonnet-5-5'], price: p(2, 2.5, 4, 0.1, 10) },
  { ids: ['claude-sonnet-5'], price: p(2, 2.5, 4, 0.2, 10) },
  {
    ids: ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4', 'claude-sonnet-4-0'],
    price: p(3, 3.75, 6, 0.3, 15),
  },
  {
    ids: ['claude-haiku-5-5'],
    price: p(0.1, 0.125, 0.2, 0.01, 0.5),
    longPrompt: { overTokens: 100_000, price: p(0.5, 0.625, 1, 0.05, 2.5) },
  },
  { ids: ['claude-haiku-4-5'], price: p(1, 1.25, 2, 0.1, 5) },
  { ids: ['claude-3-5-haiku'], price: p(0.8, 1, 1.6, 0.08, 4) },
];

const ROWS_BY_ID = new Map<string, PriceRow>();
for (const row of PRICE_ROWS) for (const id of row.ids) ROWS_BY_ID.set(id, row);

/**
 * A transcript's model id reduced to the table's form: lower case, any platform
 * prefix (`us.anthropic.`, `anthropic.`) and context suffix (`[1m]`) dropped,
 * a dated snapshot's date (`-20250805`, `@20250805`, `-v1:0`) removed.
 */
export function normalizeModelId(model: string): string {
  let id = model.trim().toLowerCase();
  const at = id.indexOf('claude-');
  if (at > 0) id = id.slice(at);
  id = id.replace(/\[[^\]]*\]$/, '');
  id = id.replace(/-v\d+(:\d+)?$/, '');
  id = id.replace(/[@-]\d{8}$/, '');
  return id;
}

/** The row for a model, or undefined when the table can't place it. */
function rowFor(model: string): PriceRow | undefined {
  return ROWS_BY_ID.get(normalizeModelId(model));
}

/** Does the table know this model? */
export function hasPrice(model: string): boolean {
  return rowFor(model) !== undefined;
}

/** One API response's token counts, as the transcript's `message.usage` states them. */
export interface MessageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** usage.speed === 'fast'. */
  fast?: boolean;
}

/** Estimated USD for one response, or undefined for a model without a price. */
export function messageCostUsd(model: string, tokens: MessageTokens): number | undefined {
  const row = rowFor(model);
  if (!row) return undefined;
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
  const price =
    row.longPrompt && prompt > row.longPrompt.overTokens ? row.longPrompt.price : row.price;
  const multiplier = tokens.fast && row.fastMultiplier ? row.fastMultiplier : 1;
  const usd =
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite5m * price.cacheWrite5m +
      tokens.cacheWrite1h * price.cacheWrite1h) /
    1_000_000;
  return usd * multiplier;
}
