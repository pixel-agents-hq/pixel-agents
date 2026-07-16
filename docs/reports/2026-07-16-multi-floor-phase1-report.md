# Multi-Floor Phase 1 — Implementation Report

**Date:** 2026-07-16
**Branch:** `feature/multi-floor` (uncommitted)
**Scope:** 18 files, +929/−220 (excludes an unrelated `CLAUDE.md` condensation
already reflected in project instructions — see §6)
**Status:** Compile clean, 213/213 server unit tests, 41/41 webview unit
tests, new e2e test passing (16.7s standalone / clean within the full
`hooks-off/lifecycle.spec.ts` file run), inventory regenerated (51 tests).

## 1. Summary

Offices can now have more than one floor. Each floor is a fully independent
grid — its own tiles, furniture, seats, agents, and pets — switchable from an
elevator-style panel in the top-left corner. This is Phase 1 of the 4-phase
multi-floor initiative (see the project decision log): core engine + editor
UI + persistence. Phase 2 (MetroCity Interior assets), Phase 3 (per-floor
department board), and Phase 4 (stairs/elevator + presets) follow after this
phase is reviewed.

User-facing docs are in [`docs/multi-floor.md`](../multi-floor.md); this
report covers what changed and how it was verified.

## 2. What changed

### 2.1 Data model (`webview-ui/src/office/types.ts`, `constants.ts`)

- New `OfficeFloor` (`id`, `name`, `layout: OfficeLayout`) and `OfficeDocument`
  (`version: 2`, `activeFloorId`, `floors: OfficeFloor[]`, optional
  `layoutRevision` hoisted from the wrapped v1 layout).
- `Character` gains `floorId: string` (which floor the character lives on)
  and an optional `name?: string` (subagents render as `"<parent> (Task)"`).
- New constants: `MAX_FLOORS = 12`, `FLOOR_NAME_MAX_LENGTH = 24`,
  `DEFAULT_FLOOR_ID`, `DEFAULT_FLOOR_NAME`,
  `FLOOR_DELETE_CONFIRM_TIMEOUT_MS = 3000`.

### 2.2 Engine (`webview-ui/src/office/engine/officeState.ts` — the bulk of the diff)

- Introduced a private `FloorRuntime` (tileMap, seats, blockedTiles,
  furniture, walkableTiles, pets) per floor, keyed in a
  `Map<string, FloorRuntime>`. The pre-existing single-floor public fields
  (`layout`, `tileMap`, `seats`, `blockedTiles`, `furniture`,
  `walkableTiles`, `pets`) became getters proxying to the **active**
  floor's runtime — every existing consumer (renderer, pathfinding,
  hit-testing, the editor's `rebuildFromLayout`) keeps working against the
  same API surface without modification.
- `loadDocument(doc)` replaces the whole multi-floor document (initial load,
  external file change, reset). Re-homes existing characters: first tries to
  keep them at their existing seat (even if that seat moved to a different
  floor via import), then falls back to any free seat on their floor, then a
  random walkable tile.
- `getDocument()` serializes all floors back to a persistable v2 document.
- `setActiveFloor`, `addFloor`, `renameFloor`, `removeFloor` — floor CRUD.
  `removeFloor` refuses to delete the last floor and re-seats its characters
  onto the fallback (first remaining) floor.
- `reassignSeat` gained cross-floor teleport: reassigning to a seat on a
  different floor moves the character's `floorId` and re-triggers the
  matrix-effect spawn animation (no cross-floor pathfinding exists, so a
  walk animation would have nowhere real to walk through).
- `addAgent`'s originally-planned `name` parameter (which had broken all 3
  call sites — see §5) was moved to an optional trailing position instead of
  a required 2nd positional argument, preserving both the existing callers
  and the sub-agent naming intent.

### 2.3 Editor actions (`webview-ui/src/hooks/useEditorActions.ts`)

- `saveLayout(layout)` became `saveDocument()` — it now always reads
  `getOfficeState().getDocument()` at save time rather than being handed a
  single floor's layout, since the persisted unit is the whole multi-floor
  document.
- `setLastSavedLayout` → `setLastSavedDocument`; `handleReset` now calls
  `officeState.loadDocument()` directly instead of routing through the
  single-floor `applyEdit`.
- Four new handlers: `handleFloorSwitch`, `handleFloorAdd`,
  `handleFloorRename`, `handleFloorDelete`. Each clears undo/redo history,
  selection, ghost, and drag state, resets the pan offset, and triggers a
  debounced save — floor structure changes are explicitly **not** undoable
  (delete's two-click confirm is the safety net instead).

### 2.4 UI (`webview-ui/src/components/FloorSwitcher.tsx`, new — 150 lines)

Elevator-style floor list (newest floor on top, first floor at the bottom —
building metaphor). Hidden entirely for a single floor outside edit mode.
Edit mode adds `+ Floor`, inline rename (double-click, Enter/Escape), and
delete (`×` → arms to `!` → confirms, auto-disarms after
`FLOOR_DELETE_CONFIRM_TIMEOUT_MS`). Wired into `App.tsx` above the zoom
controls.

`ToolOverlay.tsx` filters overlays to `ch.floorId === officeState.activeFloorId`
— agents on other floors keep animating in the background but render
nothing. `OfficeCanvas.tsx` switched from `getCharacters()` to
`getVisibleCharacters()` for the same reason on the render side.

### 2.5 Persistence & migration (`webview-ui/src/office/layout/layoutSerializer.ts`)

- `wrapLayoutAsDocument(layout)` — wraps a v1 `OfficeLayout` as the single
  floor of a v2 document.
- `migrateToDocument(raw)` — accepts either a v1 layout (`tiles[]` +
  `furniture[]`) or a v2 document (`floors[]`), migrating each floor's
  layout individually; returns `null` for unrecognized shapes so callers can
  fall back to the bundled default. Used by `useExtensionMessages.ts` on
  every `layoutLoaded` message.
- `adapters/vscode/PixelAgentsViewProvider.ts`'s import-from-file validator
  now accepts `version === 1 && tiles[]` OR `version === 2 && floors[]`.

### 2.6 Test observability (`webview-ui/src/testHooks.ts`)

Added `getFloors()` and `getActiveFloorId()` to
`window.__pixelAgentsTestHooks`, plus `floorId` on `getCharacters()`'s
per-character output — lets e2e assert floor structure and the active floor
directly instead of only inferring it from overlay visibility.

## 3. New e2e test

`e2e/tests/claude/hooks-off/lifecycle.spec.ts` › _"multi-floor: add, switch,
rename and delete floors; persists a v2 document"_ (`@area:cross-cutting`):

1. Spawns an internal agent seated on the (only) floor; confirms the floor
   switcher is absent (single floor, not in edit mode).
2. Enters edit mode → switcher appears → `+ Floor` adds a second floor and
   switches to it → the first agent's overlay disappears (floor filter
   working) → switching back to floor 1 brings it back.
3. Renames the second floor via double-click + inline input → confirms
   `layout.json` upgrades to `version: 2` on disk with both floors, one
   named `"Engineering"`.
4. Exits edit mode with 2 floors present → switcher stays visible (only
   hides at 1 floor + not-editing).
5. Deletes the second floor (two-click confirm) → back to 1 floor → exiting
   edit mode hides the switcher again.

## 4. Verification

Full scan at the start of this session found the branch didn't compile —
see §5 for what was wrong and how it was fixed. After the fix:

| Check                                                            | Result                                                                                                                                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run compile` (asyncapi + typecheck + lint + esbuild + vite) | clean, exit 0                                                                                                                                                              |
| Server unit tests                                                | 213/213                                                                                                                                                                    |
| Webview unit tests                                               | 41/41                                                                                                                                                                      |
| New multi-floor e2e test, standalone (`--retries=0`)             | pass, 16.7s                                                                                                                                                                |
| New multi-floor e2e test, first attempt in a batch run           | 1 flaky (VS Code `runCommand` quick-input timeout during fixture boot — same class of machine slowness logged previously for the panel-restore e2e; passed clean on retry) |
| Full `hooks-off/lifecycle.spec.ts` file (13 tests)               | 11 passed clean + 2 flaky-then-passed (both pre-existing, unrelated to this change) + 0 failed                                                                             |
| `npm run e2e:inventory`                                          | 50 → 51 tests, `e2e/README.md` regenerated                                                                                                                                 |
| `npx eslint e2e/tests/claude/hooks-off/lifecycle.spec.ts`        | clean                                                                                                                                                                      |

## 5. Pre-existing compile errors found and fixed

Before any e2e work could run, `npm run compile` failed with 7 TypeScript
errors from the branch's own uncommitted diff (last edited the previous
evening, before this session):

- **`addAgent()` signature mismatch.** The multi-floor engine work had
  inserted a required `name: string` as the **2nd** positional parameter
  (right after `id`), but all 3 existing call sites in
  `useExtensionMessages.ts` pass `palette` in that position — none of them
  were updated to match. Two `ch.name = ...` assignments also referenced a
  `Character.name` field that didn't exist on the type yet.
  - **Fix:** moved `name` to an optional 7th (trailing) parameter, after
    `folderName`, and added `name?: string` to the `Character` interface.
    This preserves the sub-agent `"(Task)"` naming intent without touching
    any of the 3 existing callers, which never needed to pass a name.
  - A stray monkeypatch of `addAgent` in `testHooks.ts` (for
    `addAgentLog` observability) already destructured params positionally
    and needed no change once the prototype's signature was corrected.

Also checked: the 639-line `CLAUDE.md` diff on this branch (−609/+30) looked
alarming in isolation but is a deliberate condensation to a "Core Directives"
format — it matches the file already active as this project's instructions,
not accidental damage. Left untouched.

Compile, both unit test suites, and lint were all clean after the fix, with
no other changes to the multi-floor logic itself.

## 6. Ground rules

Built directly on `feature/multi-floor` in the main checkout (no worktree
needed this time — no other feature branch was in flight). Still uncommitted
pending review and commit approval per the standing "ask before any commit"
rule.

## 7. Follow-ups

- **No cross-floor pathfinding** — reassigning a seat across floors
  teleports (matrix-effect) rather than walking. This is a deliberate Phase 1
  scope cut, not a bug; there's no path between two independent grids to
  walk along. Revisit only if a future phase adds visual floor connectors
  (stairs/elevator, Phase 4) that should carry a walk animation instead.
- **Undo/redo does not survive `handleReset`** — `handleReset` calls
  `loadDocument()` directly (bypassing `applyEdit`), consistent with floor
  operations being non-undoable, but means a reset after floor edits can't be
  undone either. Matches the "floor structure changes are not undoable"
  design; flagging in case a future review wants reset specifically to be
  undoable.
- **Phase 2–4** — MetroCity Interior assets, live-data department board,
  stairs/elevator + presets. Not started; see the project decision log for
  the agreed 4-phase split.
