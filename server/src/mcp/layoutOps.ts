/**
 * The layout as the Pixel Office MCP reads and edits it: get_layout's
 * snapshot (seats with who holds each, Areas with their Directories),
 * list_catalog's assets, and agents' edits through layoutEdits.ts.
 */

import { catalogOf } from '../officeFacts.js';
import type { LayoutEdits } from './layoutEdits.js';
import { type OfficeFacts, officeSnapshot } from './officeFacts.js';
import type { LayoutOps, OfficeLayoutSnapshot } from './officeOperations.js';

export function createLayoutOps(facts: OfficeFacts, layoutEdits: LayoutEdits): LayoutOps {
  /** Area label → the Directories mapped to it. */
  function areaDirectories(): OfficeLayoutSnapshot['areaDirectories'] {
    const byArea = new Map<string, Array<{ name: string; path: string | null }>>();
    const directories = facts.directories();
    for (const [name, areas] of Object.entries(facts.readAreaMappings())) {
      const path = directories.find((d) => d.name === name)?.path ?? null;
      for (const area of areas) {
        const list = byArea.get(area) ?? [];
        if (!list.some((d) => d.name === name)) list.push({ name, path });
        byArea.set(area, list);
      }
    }
    return byArea;
  }

  return {
    getLayout() {
      const office = officeSnapshot(facts);
      if (!office.layout) return null;
      const seats = [...office.seats].map(([id, place]) => ({
        id,
        tile: place.tile,
        area: place.area,
        takenBy: office.holders.get(id) ?? null,
      }));
      return {
        layout: office.layout,
        catalog: office.catalog,
        seats,
        areaDirectories: areaDirectories(),
      };
    },

    getAssets() {
      return { catalog: catalogOf(facts.catalog()), ...facts.assets() };
    },

    editLayout: (agentId, ops) => layoutEdits.edit(agentId, ops),

    undoLayoutEdit: () => layoutEdits.undo(),
  };
}
