/**
 * Every pure edit of an office layout, one family per file under editOps/:
 * tiles (floor and wall painting, wall sets, erase with furniture removal),
 * furniture (placement rules, surface riders, moving, copying, rotation and
 * on/off toggling), areas (carpets and Areas), grid (expansion and shrinking)
 * and pets. Each returns a new layout (or the same one when nothing changes).
 * Operations that need the furniture catalogue take it as their first
 * argument; the webview binds them to its own catalogue
 * (office/editor/editorActions.ts), the server passes the one it builds.
 */

export * from './editOps/areas.js';
export * from './editOps/furniture.js';
export * from './editOps/grid.js';
export * from './editOps/pets.js';
export * from './editOps/tiles.js';
