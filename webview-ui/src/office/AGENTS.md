# webview-ui/src/office/ - game world: state, rendering, layout, editor

Score 14 (39 files, ~9.4k LOC, barrels in `components/ engine/ layout/ sprites/ editor/`, `types.ts` ~20 importers). Five files over 500 LOC.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| World state, characters, seats, pets, greeter | `engine/officeState.ts` | 1.2k LOC |
| Draw order, overlays, edit UI | `engine/renderer.ts` | 1k LOC |
| Character FSM + wander | `engine/characters.ts` | |
| Restored-agent placement | `engine/existingAgents.ts`, `engine/seatPlacement.ts` | |
| Pets | `engine/petEntity.ts`, `sprites/petSpriteData.ts` | |
| Spawn rain | `engine/matrixEffect.ts` (draw) / `matrixEffectState.ts` (state, DOM-free) | |
| Canvas input, drag, hit-test | `components/OfficeCanvas.tsx`, `officeCanvasCursor.ts` | 820 LOC |
| Touch pan/pinch/tap | `components/useCanvasTouchGestures.ts` | |
| World->screen math | `projection.ts` | shared by renderer AND DOM overlays |
| Layout ops (pure) | `editor/editorActions.ts` | 800 LOC |
| Editor imperative state, undo sessions | `editor/editorState.ts` | |
| Ghost/selection derivation | `editor/editorRenderState.ts` | pure |
| Tool palettes | `editor/EditorToolbar.tsx` | 900 LOC |
| Catalog, rotation/state groups | `layout/furnitureCatalog.ts` | |
| Layout <-> runtime, seats | `layout/layoutSerializer.ts` | |
| Walkability, BFS | `layout/tileMap.ts` | |
| Carpet autotile | `sprites/carpetTiles.ts` | marching-squares junctions |
| Layout export | `layout/exportLayout.ts` | |

## CONVENTIONS
- Mutation vs derivation are separate: per-frame code (`getLayout()`, renderer, `editorRenderState`) only reads. Mutators (`addPet`/`removePet`/`rebuildPetsFromLayout`) sync derived layout fields.
- Every editor change goes through `commitLayout(layout, session)`; pick the right undo session key or end the stroke.
- Hit-testing is one function (`furnitureAt`); select, drag, cursor and both Copy tools must keep using it.
- Pure modules stay DOM-free so `webview-ui/test` (Node) can import them; DOM-bound code lives in `components/`.
- New entity kinds need `testHooks` accessors - canvas content has no DOM for e2e to find.

## ANTI-PATTERNS
- Calling pet/layout mutators from render-time code (`officeState.ts` comment: NEVER from `getLayout()`).
- A second world->screen formula in a DOM overlay instead of `projection.ts`.
- `ctx.scale(dpr)` or fractional zoom.
- Inline color literals in sprites/renderer outside the lint-exempt sprite data.
- Moving a desk without its surface riders, or partially applying a group move that does not fit.
