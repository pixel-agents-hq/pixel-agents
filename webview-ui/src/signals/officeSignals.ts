/**
 * The renderer's way in to the signals: the frame's furniture plus the
 * runtime-only trouble icons (troubleFurniture.ts), read from the signal store.
 */

import { getCatalogEntry } from '../office/layout/furnitureCatalog.js';
import type { FurnitureInstance } from '../office/types.js';
import { signalStore } from './signalStore.js';
import { troubleFurniture, type TroubleOffice } from './troubleFurniture.js';

/** `furniture`, with a fire or alarm lamp on the desk of every agent in trouble. */
export function furnitureWithSignals(
  office: TroubleOffice,
  furniture: FurnitureInstance[],
): FurnitureInstance[] {
  const { trouble } = signalStore.getSnapshot();
  if (trouble.size === 0) return furniture;
  const extra = troubleFurniture(
    office,
    trouble,
    (type) => getCatalogEntry(type)?.sprite,
    performance.now() / 1000,
  );
  return extra.length > 0 ? [...furniture, ...extra] : furniture;
}
