export type { CatalogEntryWithCategory, FurnitureCategory } from './furnitureCatalog.js';
export { FURNITURE_CATEGORIES, getCatalogByCategory, getCatalogEntry } from './furnitureCatalog.js';
export {
  createDefaultDocument,
  createDefaultLayout,
  deserializeLayout,
  getBlockedTiles,
  getSeatTiles,
  layoutToFurnitureInstances,
  layoutToSeats,
  layoutToTileMap,
  migrateToDocument,
  serializeLayout,
  wrapLayoutAsDocument,
} from './layoutSerializer.js';
export { findPath, getWalkableTiles, isWalkable } from './tileMap.js';
