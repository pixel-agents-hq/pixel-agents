/**
 * The editor's layout operations. They live in core (core/src/layout/editOps.ts),
 * so the server validates and edits layouts exactly as the editor does; the ones
 * that need the furniture catalogue take it as their first argument there, and
 * are bound here to the webview's catalogue (activeCatalog()).
 */

import type { FurnitureCatalog } from '../../../../core/src/layout/catalog.js';
import * as ops from '../../../../core/src/layout/editOps.js';
import { activeCatalog } from '../layout/furnitureCatalog.js';

export {
  addArea,
  addPet,
  areaStrokeErases,
  eraseArea,
  eraseCarpet,
  type ExpandDirection,
  expandLayout,
  freshFurnitureUid,
  type FurnitureMovePlan,
  isFloorTile,
  isWallLike,
  paintArea,
  paintCarpet,
  paintTile,
  paintWall,
  removeArea,
  removeFurniture,
  removeFurnitureGroup,
  removePet,
  renameArea,
  setFurnitureColor,
  setFurnitureColors,
  updateAreaColor,
  wallSetOf,
  wallStrokeAdds,
  wallStrokeTile,
} from '../../../../core/src/layout/editOps.js';

/** A core operation with its catalogue argument dropped. Only for plain
 *  (non-overloaded, non-generic) operations: `infer` would mistype those. */
type Bound<F> = F extends (catalog: FurnitureCatalog, ...rest: infer A) => infer R
  ? (...rest: A) => R
  : never;

/** Bind a core operation to the catalogue the webview built last. */
function bound<F extends (catalog: FurnitureCatalog, ...rest: never[]) => unknown>(
  op: F,
): Bound<F> {
  return ((...rest: never[]) => op(activeCatalog(), ...rest)) as Bound<F>;
}

export const canPlaceFurniture = bound(ops.canPlaceFurniture);
export const dropFurniture = bound(ops.dropFurniture);
export const duplicateFurniture = bound(ops.duplicateFurniture);
export const eraseTile = bound(ops.eraseTile);
export const furnitureAt = bound(ops.furnitureAt);
export const furnitureInBox = bound(ops.furnitureInBox);
export const getSurfaceRiders = bound(ops.getSurfaceRiders);
export const getWallPlacementRow = bound(ops.getWallPlacementRow);
export const moveFurniture = bound(ops.moveFurniture);
export const placeFurniture = bound(ops.placeFurniture);
export const placeNewFurniture = bound(ops.placeNewFurniture);
export const planFurnitureMove = bound(ops.planFurnitureMove);
export const removeFurnitureAt = bound(ops.removeFurnitureAt);
export const rotateFurniture = bound(ops.rotateFurniture);
export const rotateFurnitureGroup = bound(ops.rotateFurnitureGroup);
export const toggleFurnitureState = bound(ops.toggleFurnitureState);
export const toggleFurnitureStates = bound(ops.toggleFurnitureStates);
