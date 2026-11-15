/**
 * Wardrobe art's display text in the current language. art/wardrobe.json names parts,
 * colourways and palette squares in English; those labels stay the data (the renderer
 * matches some of them), and are translated only when shown, through `characters.w_<slug>`
 * keys. A label with no key (a custom item's own name) is shown as written.
 */

import { isItemId } from '../../../core/src/wardrobeItems.js';
import { type MessageKey, t } from '../i18n/index.js';
import { characters } from '../i18n/messages/en/characters.js';
import type { PartInfo } from './wardrobe.js';

/** 'Long-sleeved shirt' → 'long_sleeved_shirt'. */
const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** The key a wardrobe.json label is translated under, if it has one. */
export function wardrobeKey(label: string): MessageKey | null {
  const id = `w_${slug(label)}`;
  return id in characters ? (`characters.${id}` as MessageKey) : null;
}

/** A wardrobe.json label (part, colourway, palette square) as shown. */
export function wardrobeText(label: string): string {
  const key = wardrobeKey(label);
  return key ? t(key) : label;
}

/** A part's name as shown: a custom item's own name, a built-in part's translated. */
export const partName = (part: PartInfo): string =>
  isItemId(part.id) ? part.label : wardrobeText(part.label);
