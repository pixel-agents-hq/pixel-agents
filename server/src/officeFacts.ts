/**
 * The office's layout and places as a surface supplies them: built ONCE per
 * surface (cli.ts, the VS Code provider) and handed to every feature that reads
 * them — the Pixel Office MCP (mcp/officeFacts.ts extends it with what only the
 * MCP needs) and the PC shells (pcShells.ts). No feature re-plumbs its own
 * copy of these thunks, and none reaches into another's module for them.
 */

import {
  type CatalogSource,
  createFurnitureCatalog,
  type FurnitureCatalog,
} from '../../core/src/layout/index.js';

/** Directory name → the Area labels it is mapped to (config `areaMappings`). */
export type AreaMappings = Record<string, string[]>;

/** Where a surface's layout, catalogue, Directories and Area mappings come from. */
export interface OfficePlaceFacts {
  /** The saved layout (or the default one), as JSON. */
  layout(): Record<string, unknown> | null;
  /** The furniture catalogue data (empty before it is loaded). */
  catalog(): readonly CatalogSource[];
  /** This host's Directories (name → path). */
  directories(): ReadonlyArray<{ name: string; path: string }>;
  /** Directory name → the Area labels it is mapped to (the office's areaMappings). */
  readAreaMappings(): AreaMappings;
}

const catalogs = new WeakMap<readonly CatalogSource[], FurnitureCatalog | null>();

/** The catalogue built from catalogue data, once per data array. */
export function catalogOf(data: readonly CatalogSource[]): FurnitureCatalog | null {
  if (data.length === 0) return null;
  let catalog = catalogs.get(data);
  if (catalog === undefined) {
    catalog = createFurnitureCatalog(data);
    catalogs.set(data, catalog);
  }
  return catalog;
}
