/**
 * The office layout, shared by the webview's editor and the server: its data
 * model, the furniture catalogue's data side, and every pure operation on a
 * layout. No DOM, no sprites, no module state — pass the catalogue in.
 */

export * from './catalog.js';
export * from './constants.js';
export * from './editOps.js';
export * from './layoutSerializer.js';
export * from './sections.js';
export * from './tileMap.js';
export * from './types.js';
export * from './visitSpot.js';
export * from './workstations.js';
