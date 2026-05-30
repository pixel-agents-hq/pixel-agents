# Pixel Agents — Compressed Reference

VS Code extension with embedded React webview: pixel art office where AI agents (Claude Code terminals) are animated characters.

## Architecture

```
src/                          — Extension backend (Node.js, VS Code API)
  constants.ts                — Extension-only constants (VS Code IDs, key names)
  extension.ts                — Entry: activate(), deactivate()
  PixelAgentsViewProvider.ts   — WebviewViewProvider, message dispatch, asset loading, server lifecycle
  assetLoader.ts              — PNG parsing, sprite conversion, catalog building, default layout loading
  agentManager.ts             — Terminal lifecycle: launch, remove, restore, persist
  configPersistence.ts        — User-level config file I/O (~/.pixel-agents/config.json), external asset directories
  layoutPersistence.ts        — User-level layout file I/O (~/.pixel-agents/layout.json), migration, cross-window watching
  fileWatcher.ts              — fs.watch + polling, readNewLines, /clear detection, terminal adoption
  transcriptParser.ts         — JSONL parsing: tool_use/tool_result → webview messages
  timerManager.ts             — Waiting/permission timer logic
  types.ts                    — Shared interfaces (AgentState, PersistedAgent)

server/                       — Standalone server (Node.js, no VS Code deps except types)
  src/
    server.ts                 — HTTP server: hook endpoint, health check, server.json discovery
    hookEventHandler.ts       — Routes hook events to agents, buffers pre-registration events
    constants.ts              — All timing/scanning constants (shared by extension + server)
    providers/file/
      claudeHookInstaller.ts  — Install/uninstall hooks in ~/.claude/settings.json
      hooks/claude-hook.ts    — Hook script: reads stdin, POSTs to server (bundled to CJS by esbuild)
  __tests__/                  — Vitest test suite
    server.test.ts            — HTTP server lifecycle, auth, hooks, server.json
    hookEventHandler.test.ts  — Event routing, buffering, timer cancellation
    claudeHookInstaller.test.ts — Hook install/uninstall in settings.json
    claude-hook.test.ts       — Integration: spawns real hook script process

webview-ui/src/               — React + TypeScript (Vite)
  constants.ts                — All webview magic numbers/strings (grid, animation, rendering, camera, zoom, editor, game logic, notification sound)
  notificationSound.ts        — Web Audio API chime on agent turn completion, with enable/disable
  App.tsx                     — Composition root, hooks + components + EditActionBar
  hooks/
    useExtensionMessages.ts   — Message handler + agent/tool state
    useEditorActions.ts       — Editor state + callbacks
    useEditorKeyboard.ts      — Keyboard shortcut effect
  components/
    BottomToolbar.tsx          — + Agent, Layout toggle, Settings button
    ZoomControls.tsx           — +/- zoom (top-right)
    SettingsModal.tsx          — Centered modal: settings, export/import layout, sound toggle, hooks toggle, debug toggle
    InfoModal.tsx              — Reusable pixel-styled modal (used for hooks info, changelog)
    Tooltip.tsx                — First-run tooltip with dismiss + "View more" link
    DebugView.tsx              — Debug overlay
  office/
    types.ts                  — Interfaces (OfficeLayout, FloorColor, Character, etc.) + re-exports constants from constants.ts
    toolUtils.ts              — STATUS_TO_TOOL mapping, extractToolName(), defaultZoom()
    colorize.ts               — Dual-mode color module: Colorize (grayscale→HSL) + Adjust (HSL shift)
    floorTiles.ts             — Floor sprite storage + colorized cache
    wallTiles.ts              — Wall auto-tile: 16 bitmask sprites from walls.png
    sprites/
      spriteData.ts           — Pixel data: characters (6 pre-colored from PNGs, fallback templates), furniture, tiles, bubbles
      spriteCache.ts          — SpriteData → offscreen canvas, per-zoom WeakMap cache, outline sprites
    editor/
      editorActions.ts        — Pure layout ops: paint, place, remove, move, rotate, toggleState, canPlace, expandLayout
      editorState.ts          — Imperative state: tools, ghost, selection, undo/redo, dirty, drag
      EditorToolbar.tsx       — React toolbar/palette for edit mode
    layout/
      furnitureCatalog.ts     — Dynamic catalog from loaded assets + getCatalogEntry()
      layoutSerializer.ts     — OfficeLayout ↔ runtime (tileMap, furniture, seats, blocked)
      tileMap.ts              — Walkability, BFS pathfinding
    engine/
      characters.ts           — Character FSM: idle/walk/type + wander AI
      officeState.ts          — Game world: layout, characters, seats, selection, subagents
      gameLoop.ts             — rAF loop with delta time (capped 0.1s)
      renderer.ts             — Canvas: tiles, z-sorted entities, overlays, edit UI
      matrixEffect.ts         — Matrix-style spawn/despawn digital rain effect
    components/
      OfficeCanvas.tsx        — Canvas, resize, DPR, mouse hit-testing, edit interactions, drag-to-move
      ToolOverlay.tsx          — Activity status label above hovered/selected character + close button

scripts/                      — 7-stage asset extraction pipeline
  0-import-tileset.ts         — Interactive CLI wrapper
  1-detect-assets.ts          — Flood-fill asset detection
  2-asset-editor.html         — Browser UI for position/bounds editing
  3-vision-inspect.ts         — Claude vision auto-metadata
  4-review-metadata.html      — Browser UI for metadata review
  5-export-assets.ts          — Export PNGs + furniture-catalog.json
  asset-manager.html          — Unified editor (Stage 2+4 combined), Save/Save As via File System Access API
  generate-walls.js           — Generate walls.png (4×4 grid of 16×32 auto-tile pieces)
  wall-tile-editor.html       — Browser UI for editing wall tile appearance
```

## Core Concepts

**Vocabulary**: Terminal = VS Code terminal running Claude. Session = JSONL conversation file. Agent = webview character bound 1:1 to a terminal.

**Extension ↔ Webview**: `postMessage` protocol. Key messages: `openClaude`, `agentCreated/Closed`, `focusAgent`, `agentToolStart/Done/Clear`, `agentStatus`, `existingAgents`, `layoutLoaded`, `furnitureAssetsLoaded`, `floorTilesLoaded`, `wallTilesLoaded`, `saveLayout`, `saveAgentSeats`, `exportLayout`, `importLayout`, `settingsLoaded` (includes `externalAssetDirectories`), `setSoundEnabled`, `addExternalAssetDirectory`, `removeExternalAssetDirectory` (field: `path`), `externalAssetDirectoriesUpdated` (field: `dirs`).

**One-agent-per-terminal**: Each "+ Agent" click → new terminal (`claude --session-id <uuid>`) → immediate agent creation → 1s poll for `<uuid>.jsonl` → file watching starts.

**Terminal adoption**: Project-level 1s scan detects unknown JSONL files. If active terminal has no agent → adopt. If focused agent exists → reassign (`/clear` handling).

## Agent Status Tracking

JSONL transcripts at `~/.claude/projects/<project-hash>/<session-id>.jsonl`. Project hash = workspace path with `:`/`\`/`/` → `-`.

**JSONL record types**: `assistant` (tool_use blocks or thinking), `user` (tool_result or text prompt), `system` with `subtype: "turn_duration"` (reliable turn-end signal), `progress` with `data.type`: `agent_progress` (sub-agent tool_use/tool_result forwarded to webview, non-exempt tools trigger permission timers), `bash_progress` (long-running Bash output — restarts permission timer to confirm tool is executing), `mcp_progress` (MCP tool status — same timer restart logic). Also observed but not tracked: `file-history-snapshot`, `queue-operation`.

**File watching**: Single polling approach (500ms). Partial line buffering for mid-write reads. Tool done messages delayed 300ms to prevent flicker.

**Dual-mode session detection**: Hooks mode (preferred) uses Claude Code Hooks API for instant, reliable detection. Heuristic mode (fallback) uses filesystem polling when hooks are unavailable. The `hookDelivered` flag per agent and `hooksEnabledRef` globally control the switch.

**Hooks mode** (11 events): `SessionStart` (session begin/resume/clear), `SessionEnd` (exit/clear), `Stop` (turn complete), `PermissionRequest`, `Notification` (idle/permission prompt), `UserPromptSubmit` (instant agent spawn confirmation), `PreToolUse` (instant active state), `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`. HTTP server (`server/src/server.ts`) receives events via `~/.pixel-agents/hooks/claude-hook.js`. Server discovery via `~/.pixel-agents/server.json` (port + PID + auth token). Multi-window safe. When hooks are active, heuristic scanners (main 1s, external 3s, stale 30s) are skipped entirely.

**Heuristic mode** (fallback): Per-agent 500ms JSONL polling for /clear detection, 1s main scanner for terminal adoption, 3s external scanner, 30s stale check. Content-based /clear detection (`/clear</command-name>` in first 8KB). Multiple dismissal systems (clearDismissedFiles, dismissedJsonlFiles, seededMtimes, pendingClearFiles).

**JSONL polling** (always active): `readNewLines` + `processTranscriptLine` run in both modes for tool content (status text, animations). Only timer logic (permission 7s, text-idle 5s) is suppressed by `hookDelivered`.

**Extension state per agent**: `id, terminalRef, projectDir, jsonlFile, fileOffset, lineBuffer, activeToolIds, activeToolStatuses, activeSubagentToolNames, isWaiting`.

**Persistence**: Agents persisted to `workspaceState` key `'pixel-agents.agents'` (includes palette/hueShift/seatId). **Layout persisted to `~/.pixel-agents/layout.json`** (user-level, shared across all VS Code windows/workspaces). `layoutPersistence.ts` handles all file I/O: `readLayoutFromFile()`, `writeLayoutToFile()` (atomic via `.tmp` + rename), `migrateAndLoadLayout()` (checks file → migrates old workspace state → falls back to bundled default), `watchLayoutFile()` (hybrid `fs.watch` + 2s polling for cross-window sync). On save, `markOwnWrite()` prevents the watcher from re-reading our own write. External changes push `layoutLoaded` to the webview; skipped if the editor has unsaved changes (last-save-wins). On webview ready: `restoreAgents()` matches persisted entries to live terminals. `nextAgentId`/`nextTerminalIndex` advanced past restored values. **Default layout**: When no saved layout file exists and no workspace state to migrate, a bundled `default-layout.json` is loaded from `assets/` and written to the file. If that also doesn't exist, `createDefaultLayout()` generates a basic office. To update the default: run "Pixel Agents: Export Layout as Default" from the command palette (writes current layout to `webview-ui/public/assets/default-layout.json`), then rebuild. **Export/Import**: Settings modal offers Export Layout (save dialog → JSON file) and Import Layout (open dialog → validates `version: 1` + `tiles` array → writes to layout file + pushes `layoutLoaded` to webview). **Config persisted to `~/.pixel-agents/config.json`** (user-level, shared across windows). `configPersistence.ts` handles read/write with atomic tmp+rename. Currently stores `externalAssetDirectories: string[]` for external asset pack paths. **External asset directories**: Settings modal offers Add/Remove Asset Directory. External furniture merged with bundled assets on boot and on add/remove via `mergeLoadedAssets()` (external IDs override bundled on collision).

## Office UI

**Rendering**: Game state in imperative `OfficeState` class (not React state). Pixel-perfect: zoom = integer device-pixels-per-sprite-pixel (1x–10x). No `ctx.scale(dpr)`. Default zoom = `Math.round(2 * devicePixelRatio)`. Z-sort all entities by Y. Pan via middle-mouse drag (`panRef`). **Camera follow**: `cameraFollowId` (separate from `selectedAgentId`) smoothly centers camera on the followed agent; set on agent click, cleared on deselection or manual pan.

**UI styling**: Pixel art aesthetic — all overlays use sharp corners (`borderRadius: 0`), solid backgrounds (`#1e1e2e`), `2px solid` borders, hard offset shadows (`2px 2px 0px #0a0a14`, no blur). CSS variables defined in `index.css` `:root` (`--pixel-bg`, `--pixel-border`, `--pixel-accent`, etc.). Pixel font: FS Pixel Sans (`webview-ui/src/fonts/`), loaded via `@font-face` in `index.css`, applied globally.

**Characters**: FSM states — active (pathfind to seat, typing/reading animation by tool type), idle (wander randomly with BFS, return to seat for rest after `wanderLimit` moves). 4-directional sprites, left = flipped right. Tool animations: typing (Write/Edit/Bash/Task) vs reading (Read/Grep/Glob/WebFetch). Sitting offset: characters shift down 6px when in TYPE state so they visually sit in their chair. Z-sort uses `ch.y + TILE_SIZE/2 + 0.5` so characters render in front of same-row furniture (chairs) but behind furniture at lower rows (desks, bookshelves). Chair z-sorting: non-back chairs use `zY = (row+1)*TILE_SIZE` (capped to first row) so characters at any seat tile render in front; back-facing chairs use `zY = (row+1)*TILE_SIZE + 1` so the chair back renders in front of the character. Chair tiles are blocked for all characters except their own assigned seat (per-character pathfinding via `withOwnSeatUnblocked`). **Diverse palette assignment**: `pickDiversePalette()` counts palettes of current non-sub-agent characters; picks randomly from least-used palette(s). First 6 agents each get a unique skin; beyond 6, skins repeat with a random hue shift (45–315°) via `adjustSprite()`. Character stores `palette` (0-5) + `hueShift` (degrees). Sprite cache keyed by `"palette:hueShift"`.

**Spawn/despawn effect**: Matrix-style digital rain animation (0.3s). 16 vertical columns sweep top-to-bottom with staggered timing (per-column random seeds). Spawn: green rain reveals character pixels behind the sweep. Despawn: character pixels consumed by green rain trails. `matrixEffect` field on Character (`'spawn'`/`'despawn'`/`null`). Normal FSM is paused during effect. Despawning characters skip hit-testing. Restored agents (`existingAgents`) use `skipSpawnEffect: true` to appear instantly. `matrixEffect.ts` contains `renderMatrixEffect()` (per-pixel rendering) called from renderer instead of cached sprite draw.

**Sub-agents**: Negative IDs (from -1 down). Created on `agentToolStart` with "Subtask:" prefix. Same palette + hueShift as parent. Click focuses parent terminal. Not persisted. Spawn at closest free seat to parent (Manhattan distance); fallback: closest walkable tile. **Sub-agent permission detection**: when a sub-agent runs a non-exempt tool, `startPermissionTimer` fires on the parent agent; if 5s elapse with no data, permission bubbles appear on both parent and sub-agent characters. `activeSubagentToolNames` (parentToolId → subToolId → toolName) tracks which sub-tools are active for the exempt check. Cleared when data resumes or Task completes.

**Speech bubbles**: Permission ("..." amber dots) stays until clicked/cleared. Waiting (green checkmark) auto-fades 2s. Sprites in `spriteData.ts`.

**Sound notifications**: Ascending two-note chime (E5 → E6) via Web Audio API plays when waiting bubble appears (`agentStatus: 'waiting'`). `notificationSound.ts` manages AudioContext lifecycle; `unlockAudio()` called on canvas mousedown to ensure context is resumed (webviews start suspended). Toggled via "Sound Notifications" checkbox in Settings modal. Enabled by default; persisted in extension `globalState` key `pixel-agents.soundEnabled`, sent to webview as `settingsLoaded` on init.

**Seats**: Derived from chair furniture. `layoutToSeats()` creates a seat at every footprint tile of every chair. Multi-tile chairs (e.g. 2-tile couches) produce multiple seats keyed `uid` / `uid:1` / `uid:2`. Facing direction priority: 1) chair `orientation` from catalog (front→DOWN, back→UP, left→LEFT, right→RIGHT), 2) adjacent desk direction, 3) forward (DOWN). Click character → select (white outline) → click available seat → reassign.

## Layout Editor

Toggle via "Layout" button. Tools: SELECT (default), Floor paint, Wall paint, Erase (set tiles to VOID), Furniture place, Furniture pick (eyedropper for furniture type), Eyedropper (floor).

**Floor**: 7 patterns from `floors.png` (grayscale 16×16), colorizable via HSBC sliders (Photoshop Colorize). Color baked per-tile on paint. Eyedropper picks pattern+color.

**Walls**: Separate Wall paint tool. Click/drag to add walls; click/drag existing walls to remove (toggle direction set by first tile of drag, tracked by `wallDragAdding`). HSBC color sliders (Colorize mode) apply to all wall tiles at once. Eyedropper on a wall tile picks its color and switches to Wall tool. Furniture cannot be placed on wall tiles, but background rows (top N `backgroundTiles` rows) may overlap walls.

**Furniture**: Ghost preview (green/red validity). R key rotates, T key toggles on/off state. Drag-to-move in SELECT. Delete button (red X) + rotate button (blue arrow) on selected items. Any selected furniture shows HSBC color sliders (Color toggle + Clear button); color stored per-item in `PlacedFurniture.color?`. Single undo entry per color-editing session (tracked by `colorEditUidRef`). Pick tool copies type+color from placed item. Surface items preferred when clicking stacked furniture.

**Undo/Redo**: 50-level, Ctrl+Z/Y. EditActionBar (top-center when dirty): Undo, Redo, Save, Reset.

**Multi-stage Esc**: exit furniture pick → deselect catalog → close tool tab → deselect furniture → close editor.

**Erase tool**: Sets tiles to `TileType.VOID` (transparent, non-walkable, no furniture). Right-click in floor/wall/erase tools also erases to VOID (supports drag-erasing). Context menu suppressed in edit mode.

**Grid expansion**: In floor/wall/erase tools, a ghost border (dashed outline) appears 1 tile outside the grid. Clicking a ghost tile calls `expandLayout()` to grow the grid by 1 tile in that direction (left/right/up/down). New tiles are VOID. Furniture positions and character positions shift when expanding left/up. Max grid size: `MAX_COLS`×`MAX_ROWS` (64×64). Default: `DEFAULT_COLS`×`DEFAULT_ROWS` (20×11). Characters outside bounds after resize are relocated to random walkable tiles.

**Layout model**: `{ version: 1, cols, rows, tiles: TileType[], furniture: PlacedFurniture[], tileColors?: FloorColor[] }`. Grid dimensions are dynamic (not fixed constants). Persisted via debounced saveLayout message → `writeLayoutToFile()` → `~/.pixel-agents/layout.json`.

## Asset System

**Loading**: `esbuild.js` copies `webview-ui/public/assets/` → `dist/assets/`. Loader checks bundled path first, falls back to workspace root. PNG → pngjs → SpriteData (2D hex array, alpha≥2 = visible, `#RRGGBBAA` for semi-transparent). `loadDefaultLayout()` reads `assets/default-layout.json` (JSON OfficeLayout) as fallback for new workspaces.

**Catalog**: `furniture-catalog.json` with id, name, label, category, footprint, isDesk, canPlaceOnWalls, groupId?, orientation?, state?, canPlaceOnSurfaces?, backgroundTiles?. String-based type system (no enum constraint). Categories: desks, chairs, storage, electronics, decor, wall, misc. Wall-placeable items (`canPlaceOnWalls: true`) use the `wall` category and appear in a dedicated "Wall" tab in the editor. Asset naming convention: `{BASE}[_{ORIENTATION}][_{STATE}]` (e.g., `MONITOR_FRONT_OFF`, `CRT_MONITOR_BACK`). `orientation` is stored on `FurnitureCatalogEntry` and used for chair z-sorting and seat facing direction.

**Rotation groups**: `buildDynamicCatalog()` builds `rotationGroups` Map from assets sharing a `groupId`. Flexible: supports 2+ orientations (e.g., front/back only). Editor palette shows 1 item per group (front orientation preferred). `getRotatedType()` cycles through available orientations.

**State groups**: Items with `state: "on"` / `"off"` sharing the same `groupId` + `orientation` form toggle pairs. `stateGroups` Map enables `getToggledType()` lookup. Editor palette hides on-state variants, showing only the off/default version. State groups are mirrored across orientations (on-state variants get their own rotation groups).

**Auto-state**: `officeState.rebuildFurnitureInstances()` swaps electronics to ON sprites when an active agent faces a desk with that item nearby (3 tiles deep in facing direction, 1 tile to each side). Operates at render time without modifying the saved layout.

**Background tiles**: `backgroundTiles?: number` on `FurnitureCatalogEntry` — top N footprint rows allow other furniture to be placed on them AND characters to walk through them. Items on background rows render behind the host furniture via z-sort (lower zY). Both `getBlockedTiles()` and `getPlacementBlockedTiles()` skip bg rows; `canPlaceFurniture()` also skips the new item's own bg rows (symmetric placement). Set via asset-manager.html "Background Tiles" field.

**Surface placement**: `canPlaceOnSurfaces?: boolean` on `FurnitureCatalogEntry` — items like laptops, monitors, mugs can overlap with all tiles of `isDesk` furniture. `canPlaceFurniture()` builds a desk-tile set and excludes it from collision checks for surface items. Z-sort fix: `layoutToFurnitureInstances()` pre-computes desk zY per tile; surface items get `zY = max(spriteBottom, deskZY + 0.5)` so they render in front of the desk. Set via asset-manager.html "Can Place On Surfaces" checkbox. Exported through `5-export-assets.ts` → `furniture-catalog.json`.

**Wall placement**: `canPlaceOnWalls?: boolean` on `FurnitureCatalogEntry` — items like paintings, windows, clocks can only be placed on wall tiles (and cannot be placed on floor). `canPlaceFurniture()` requires the bottom row of the footprint to be on wall tiles; upper rows may extend above the map (negative row) or into VOID tiles. `getWallPlacementRow()` offsets placement so the bottom row aligns with the hovered tile. Items can have negative `row` values in `PlacedFurniture`. Set via asset-manager.html "Can Place On Walls" checkbox.

**Colorize module**: Shared `colorize.ts` with two modes selected by `FloorColor.colorize?` flag. **Colorize mode** (Photoshop-style): grayscale → luminance → contrast → brightness → fixed HSL; always used for floor tiles. **Adjust mode** (default for furniture and character hue shifts): shifts original pixel HSL — H rotates hue (±180), S shifts saturation (±100), B/C shift lightness/contrast. `adjustSprite()` exported for reuse (character hue shifts). Toolbar shows a "Colorize" checkbox to toggle modes. Generic `Map<string, SpriteData>` cache keyed by arbitrary string (includes colorize flag). `layoutToFurnitureInstances()` colorizes sprites when `PlacedFurniture.color` is set.

**Floor tiles**: `floors.png` (112×16, 7 patterns). Cached by (pattern, h, s, b, c). Migration: old layouts auto-mapped to new patterns.

**Wall tiles**: `walls.png` (64×128, 4×4 grid of 16×32 pieces). 4-bit auto-tile bitmask (N=1, E=2, S=4, W=8). Sprites extend 16px above tile (3D face). Loaded by extension → `wallTilesLoaded` message. `wallTiles.ts` computes bitmask at render time. Colorizable via HSBC sliders (Colorize mode, stored per-tile in `tileColors`). Wall sprites are z-sorted with furniture and characters (`getWallInstances()` builds `FurnitureInstance[]` with `zY = (row+1)*TILE_SIZE`); only the flat base color is rendered in the tile pass. `generate-walls.js` creates the PNG; `wall-tile-editor.html` for visual editing.

**Character sprites**: 6 pre-colored PNGs (`assets/characters/char_0.png`–`char_5.png`), one per palette. Each 112×96: 7 frames × 16px wide, 3 direction rows × 32px tall (24px sprite bottom-aligned with 8px top padding). Row 0 = down, Row 1 = up, Row 2 = right. Frame order: walk1, walk2, walk3, type1, type2, read1, read2. No dedicated idle frames — idle uses walk2 (standing pose). Left = flipped right at runtime. Generated by `scripts/export-characters.ts` which bakes `CHARACTER_PALETTES` colors into templates. Loaded by extension → `characterSpritesLoaded` message (array of 6 character sprite sets). `spriteData.ts` uses pre-colored data directly (no palette swapping); hardcoded template fallback when PNGs not loaded. When `hueShift !== 0`, `hueShiftSprites()` applies `adjustSprite()` (HSL hue rotation) to all frames before caching.

**Load order**: `characterSpritesLoaded` → `floorTilesLoaded` → `wallTilesLoaded` → `furnitureAssetsLoaded` (catalog built synchronously) → `layoutLoaded`.

## Condensed Lessons

- `fs.watch` unreliable on Windows — always pair with polling backup
- Partial line buffering essential for append-only file reads (carry unterminated lines)
- Delay `agentToolDone` 300ms to prevent React batching from hiding brief active states
- **Idle detection** has two signals: (1) `system` + `subtype: "turn_duration"` — reliable for tool-using turns (~98%), emitted once per completed turn, handler clears all tool state as safety measure. (2) Text-idle timer (`TEXT_IDLE_DELAY_MS = 5s`) — for text-only turns where `turn_duration` is never emitted. Only starts when `hadToolsInTurn` is false (no tools used yet in this turn); if any tool_use arrives, `hadToolsInTurn` becomes true and the timer is suppressed for the rest of the turn. Reset on new user prompt or `turn_duration`. Cancelled by ANY new JSONL data arriving in `readNewLines`. Only fires after 5s of complete file silence
- User prompt `content` can be string (text) or array (tool_results) — handle both
- `/clear` creates NEW JSONL file (old file just stops)
- `--output-format stream-json` needs non-TTY stdin — can't use with VS Code terminals
- Hook-based IPC failed (hooks captured at startup, env vars don't propagate). JSONL watching works
- PNG→SpriteData: pngjs for RGBA buffer, alpha threshold 2 (`PNG_ALPHA_THRESHOLD`), supports `#RRGGBBAA` semi-transparent pixels
- OfficeCanvas selection changes are imperative (`editorState.selectedFurnitureUid`); must call `onEditorSelectionChange()` to trigger React re-render for toolbar

## Build & Dev

```sh
npm install && cd webview-ui && npm install && cd ../server && npm install && cd .. && npm run build
```

Build: type-check → lint → esbuild (extension) → vite (webview). F5 for Extension Dev Host.

Testing:

- `npm test` -- all unit/integration tests (webview + server)
- `npm run test:server` -- server tests (Vitest)
- `npm run test:webview` -- webview asset integration tests (Node test runner)
- `npm run e2e` -- Playwright E2E tests (real VS Code instance)

## TypeScript Constraints

- No `enum` (`erasableSyntaxOnly`) — use `as const` objects
- `import type` required for type-only imports (`verbatimModuleSyntax`)
- `noUnusedLocals` / `noUnusedParameters`

## Constants

All magic numbers and strings are centralized — never add inline constants to source files:

- **Extension backend**: `src/constants.ts` — timing intervals, display truncation limits, PNG/asset parsing values, VS Code command/key identifiers
- **Webview**: `webview-ui/src/constants.ts` — grid/layout sizes, character animation speeds, matrix effect params, rendering offsets/colors, camera, zoom, editor defaults, game logic thresholds
- **CSS styling**: `webview-ui/src/index.css` `:root` block — `--pixel-*` custom properties for UI colors, backgrounds, borders, z-indices used in React inline styles
- **Canvas overlay colors** (rgba strings for seats, grids, ghosts, buttons) live in the webview constants file since they're used in canvas 2D context, not CSS
- `webview-ui/src/office/types.ts` re-exports grid/layout constants (`TILE_SIZE`, `DEFAULT_COLS`, etc.) from `constants.ts` for backward compatibility — import from either location

## Key Patterns

- `crypto.randomUUID()` works in VS Code extension host
- Terminal `cwd` option sets working directory at creation
- `/add-dir <path>` grants session access to additional directory

## Windows-MCP (Desktop Automation)

- `uvx --python 3.13 windows-mcp` — Tools: Snapshot, Click, Type, Scroll, Move, Shortcut, App, Shell, Wait, Scrape
- Webview buttons show `(0,0)` in a11y tree — must use `Snapshot(use_vision=true)` for coordinates
- Snap both VS Code windows side-by-side on SAME screen before clicking in Extension Dev Host
- Reload extension via button on main VS Code window after building

## Key Decisions

- `WebviewViewProvider` (not `WebviewPanel`) — lives in panel area alongside terminal
- Inline esbuild problem matcher (no extra extension needed)
- Webview is separate Vite project with own `node_modules`/`tsconfig`
- Hook script (`claude-hook.ts`) bundled to standalone CJS via esbuild (`buildHooks()` in esbuild.js), output: `dist/hooks/claude-hook.js`
- Constants centralized in `server/src/constants.ts` (shared), `src/constants.ts` imports from there. Extension-only constants stay in `src/constants.ts`
- Server always starts regardless of hooks toggle (foundation for future WS transport). Only hook installation is gated by the setting

## Honesty & Accuracy Rules

You are committed to honesty and accuracy above all else. Follow these rules in every response:

1. **UNCERTAINTY** — If you are not fully certain about a fact, say so clearly. Use phrases like "I'm not certain, but...", "You should verify this...", or "I may be wrong here, but...". Never state uncertain things as facts.
2. **SOURCES** — Do not invent paper titles, URLs, or book references. If you cannot name a real, verifiable source, say so. It is better to admit you don't know the source than to fabricate one.
3. **STATISTICS & NUMBERS** — Flag any statistic you are not 100% confident in. Say "I believe this is approximately..." and recommend the user verify it from an official or primary source.
4. **RECENT EVENTS** — Remind the user when a topic may have changed since your knowledge cutoff. Do not guess at current events or present outdated info as current.
5. **PEOPLE & QUOTES** — Never attribute a quote to a real person unless you are certain they said it. If unsure, say "I cannot confirm this quote is accurate."
