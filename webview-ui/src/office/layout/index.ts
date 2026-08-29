export type { CatalogEntryWithCategory, FurnitureCategory } from './furnitureCatalog.js';
export { FURNITURE_CATEGORIES, getCatalogByCategory, getCatalogEntry } from './furnitureCatalog.js';
export {
  createDefaultLayout,
  deserializeLayout,
  getBlockedTiles,
  getSeatTiles,
  layoutToFurnitureInstances,
  layoutToSeats,
  layoutToTileMap,
  serializeLayout,
} from './layoutSerializer.js';
export { getLoungeTiles, isLoungeFurnitureType } from './loungeTiles.js';
export { findPath, getWalkableTiles, isWalkable } from './tileMap.js';
