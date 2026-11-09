/**
 * The app's cast (see cast.ts): saved to the server over the transport, with the wardrobe
 * decoded into its renderer once loaded. The renderer's wardrobe also holds the custom
 * items, saved and drafted (an item never changes once made, so both can be shown at once);
 * it is rebuilt whenever that set of items changes.
 */

import { useSyncExternalStore } from 'react';

import type { WardrobeItem } from '../../../core/src/wardrobeItems.js';
import { transport } from '../transport/index.js';
import { type CastState, CastStore } from './cast.js';
import { decodeItemPng, loadWardrobe } from './loadWardrobe.js';
import { CharacterRenderer } from './renderer.js';
import { type ItemArt, type Wardrobe, withItems } from './wardrobe.js';

export type { CastState } from './cast.js';

export const castStore = new CastStore({
  save: (profiles, saveId, items) =>
    transport.send({ type: 'saveCharacterProfiles', profiles, saveId, items }),
});

/** Each item's decoded sheet by id (null: it didn't decode), or its decode in progress. */
const itemArt = new Map<string, Uint8ClampedArray | null>();
const decoding = new Map<string, Promise<void>>();
let wardrobe: Wardrobe | null = null;
/** The item ids the current renderer was built with. */
let builtWith: string | null = null;

/** An item's sheet the view made itself: no decode needed, so the renderer can show it at once. */
export function registerItemArt(id: string, data: Uint8ClampedArray): void {
  itemArt.set(id, data);
}

/** The saved items and the draft's, each id once. */
function shownItems({ items, draftItems }: CastState): WardrobeItem[] {
  const byId = new Map<string, WardrobeItem>();
  for (const item of [...items, ...(draftItems ?? [])]) byId.set(item.id, item);
  return [...byId.values()];
}

/** Rebuild the renderer when the shown items change; decodes any it hasn't seen first. */
function refreshRenderer(): void {
  if (!wardrobe) return;
  const items = shownItems(castStore.getState());
  const missing = items.filter((i) => !itemArt.has(i.id));
  if (missing.length) {
    for (const item of missing) {
      if (decoding.has(item.id)) continue;
      decoding.set(
        item.id,
        decodeItemPng(item.png).then((data) => {
          decoding.delete(item.id);
          itemArt.set(item.id, data);
          refreshRenderer();
        }),
      );
    }
    return;
  }
  const key = items.map((i) => i.id).join(',');
  if (key === builtWith) return;
  builtWith = key;
  const art: ItemArt[] = items.flatMap((i) => {
    const data = itemArt.get(i.id);
    return data ? [{ id: i.id, piece: i.piece, label: i.label, base: i.base, data }] : [];
  });
  castStore.setRenderer(new CharacterRenderer(withItems(wardrobe, art)));
}

void loadWardrobe().then((w) => {
  wardrobe = w;
  refreshRenderer();
});
castStore.subscribe(refreshRenderer);

// a save sent just before the connection dropped may never be answered
transport.onStateChange((state) => {
  if (state === 'connected') castStore.resendInFlight();
});

/** The cast, re-rendering on every change. */
export function useCast(): CastState {
  return useSyncExternalStore(castStore.subscribe, castStore.getState);
}
