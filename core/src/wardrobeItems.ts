/**
 * Custom wardrobe items: parts the user saved from the pixel editor, worn by any character
 * like the built-in ones. An item is one piece's 128x96 sheet, uncoloured, as a base64 PNG;
 * it takes the colourways and palette of the built-in part it was started from (`base`).
 *
 * Pure data and validation, safe on both sides of the wire. Whether the PNG decodes to a
 * sheet is the webview's to judge (an item that doesn't is left out of the wardrobe; one saved
 * before the seated frame, 112x96, gets it derived).
 */

import { CHARACTER_SLOTS, type CharacterSlot } from './characterProfiles.js';
import { isRecord } from './isRecord.js';
import type { WardrobeItem } from './messages.js';

export type { WardrobeItem };

/** The slots an item can be worn in: every one that holds a part besides the body and its underwear. */
export type ItemPiece = Exclude<CharacterSlot, 'body' | 'utop' | 'under'>;
const NOT_ITEM_PIECES: readonly CharacterSlot[] = ['body', 'utop', 'under'];
export const ITEM_PIECES: readonly ItemPiece[] = CHARACTER_SLOTS.filter(
  (slot): slot is ItemPiece => !NOT_ITEM_PIECES.includes(slot),
);

/** Upper bound on the saved items, so a hostile payload can't grow the file without limit. */
export const MAX_WARDROBE_ITEMS = 200;
/** A sheet PNG is a few KB; this bounds one item's base64. */
export const MAX_WARDROBE_ITEM_PNG_CHARS = 128 * 1024;
const MAX_LABEL_CHARS = 64;

/** An item's part id: prefixed so it can never shadow a built-in part. */
export const ITEM_ID_RE = /^custom_[a-z0-9]{1,40}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE_RE = /^[a-z0-9_]{1,64}$/;

export const isItemPiece = (piece: string): piece is ItemPiece =>
  (ITEM_PIECES as readonly string[]).includes(piece);

export const isItemId = (id: string | undefined): boolean => !!id && ITEM_ID_RE.test(id);

function isWardrobeItem(value: unknown): value is WardrobeItem {
  if (!isRecord(value)) return false;
  const v = value;
  const allowed = new Set(['id', 'piece', 'label', 'base', 'png']);
  if (Object.keys(v).some((k) => !allowed.has(k))) return false;
  return (
    typeof v.id === 'string' &&
    ITEM_ID_RE.test(v.id) &&
    typeof v.piece === 'string' &&
    isItemPiece(v.piece) &&
    typeof v.label === 'string' &&
    v.label.trim().length > 0 &&
    v.label.length <= MAX_LABEL_CHARS &&
    typeof v.base === 'string' &&
    BASE_RE.test(v.base) &&
    typeof v.png === 'string' &&
    v.png.length <= MAX_WARDROBE_ITEM_PNG_CHARS &&
    BASE64_RE.test(v.png)
  );
}

/**
 * The items in `value` when it is a bounded list of valid items with unique ids; otherwise
 * null. The ONE validator: the server runs it before persisting, the webview before decoding.
 */
export function parseWardrobeItems(value: unknown): WardrobeItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_WARDROBE_ITEMS) return null;
  if (!value.every(isWardrobeItem)) return null;
  const ids = new Set(value.map((item) => item.id));
  return ids.size === value.length ? value : null;
}
