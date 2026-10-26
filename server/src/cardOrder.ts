import type { StateAdapter } from '../../core/src/adapter.js';
import { MAX_CARD_ORDER_LENGTH } from './constants.js';

/**
 * The agent cards' order, owned by the server so every client of a surface —
 * the desktop office and the phone — shows the same cards in the same order.
 * Both surfaces load it on webviewReady and save it on saveCardOrder through
 * these helpers; persistence is the StateAdapter's (beside agents and seats).
 */

/** A card order from untrusted JSON: agent ids (non-negative integers), each
 *  once, at most MAX_CARD_ORDER_LENGTH. null when it isn't a list at all. */
export function parseCardOrder(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const ids = raw.filter((v): v is number => Number.isSafeInteger(v) && (v as number) >= 0);
  return [...new Set(ids)].slice(0, MAX_CARD_ORDER_LENGTH);
}

/** The message that tells a client the order. */
export function cardOrderMessage(adapter: StateAdapter | undefined) {
  return { type: 'cardOrderLoaded', order: adapter?.loadCardOrder() ?? [] } as const;
}

/** Persist a client's reorder, keeping only agents that still exist. Returns
 *  the message to broadcast, or null for a payload that isn't an order. */
export function saveCardOrder(
  adapter: StateAdapter | undefined,
  raw: unknown,
  isAgent: (id: number) => boolean,
): ReturnType<typeof cardOrderMessage> | null {
  const order = parseCardOrder(raw);
  if (!order || !adapter) return null;
  adapter.saveCardOrder(order.filter(isAgent));
  return cardOrderMessage(adapter);
}
