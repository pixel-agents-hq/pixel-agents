/**
 * Where a PC shell opens: the piece that asked (a placed furniture uid whose
 * furniture declares the `terminal` panel), the Area it stands in, and the
 * Directories mapped to that Area. Pure, by core's layout model, for every
 * surface: standalone (terminal/pcShells.ts) falls back to the home folder,
 * VS Code to its first workspace folder.
 */

import type { FurnitureCatalog, OfficeLayout } from '../../core/src/layout/index.js';
import { catalogEntry, footprintTiles } from '../../core/src/layout/index.js';
import { areaAt } from './mcp/seatPlace.js';

/** A Directory as the place resolution needs it. */
export interface PlaceDirectory {
  name: string;
  path: string;
}

export type PcShellPiece =
  | {
      ok: true;
      /** The piece's furniture type now (its card draws this sprite). */
      type: string;
      /** The Area the piece stands in, or null. */
      area: string | null;
      /** The Directories mapped to that Area, in the given order (none without an Area). */
      directories: PlaceDirectory[];
    }
  | { ok: false; reason: string };

/**
 * The piece `uid` as a PC shell sees it, or why it opens no shell (not in the
 * layout, or its furniture declares no `terminal` panel). Its Area is the first
 * of its footprint's tiles that has one.
 */
export function pcShellPiece(input: {
  layout: OfficeLayout | null;
  catalog: FurnitureCatalog | null;
  uid: string;
  /** Directory name → the Area labels it is mapped to (config `areaMappings`). */
  areaMappings: Readonly<Record<string, readonly string[]>>;
  directories: readonly PlaceDirectory[];
}): PcShellPiece {
  const { layout, catalog, uid } = input;
  const piece = layout?.furniture.find((f) => f.uid === uid);
  if (!layout || !catalog || !piece) return { ok: false, reason: `No piece ${uid} in the layout.` };
  if (catalogEntry(catalog, piece.type)?.interactive?.panel !== 'terminal') {
    return { ok: false, reason: `Piece ${uid} opens no terminal.` };
  }
  const area =
    footprintTiles(catalog, piece)
      .map((tile) => areaAt(layout, tile))
      .find((label) => label !== null) ?? null;
  const seen = new Set<string>();
  const directories =
    area === null
      ? []
      : input.directories.filter((d) => {
          if (seen.has(d.name) || !input.areaMappings[d.name]?.includes(area)) return false;
          seen.add(d.name);
          return true;
        });
  return { ok: true, type: piece.type, area, directories };
}

/** The Directory a new shell opens in without one named: the Area's only one, else none. */
export function soleDirectory(directories: readonly PlaceDirectory[]): PlaceDirectory | null {
  return directories.length === 1 ? directories[0] : null;
}
