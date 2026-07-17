# Multi-Floor Phase 3 — Implementation Report

**Date:** 2026-07-16
**Scope:** 17 files (12 modified + 5 new), +213/−55 in tracked diffs (plus
5 new files not yet in that count: `DepartmentBoard.tsx`,
`departmentBoard.ts`, `zoomUtils.ts`, `departmentBoard.test.ts`,
`docs/department-board.md`).
**Status:** Compile clean. 213/213 server unit tests, 50/50 webview unit
tests (9 new). New e2e test passing (16.5s and 15.1s across two clean runs;
14/14 tests in the full `hooks-off/lifecycle.spec.ts` file, 13 clean + 1
pre-existing unrelated flaky). Not yet committed.

## 1. Summary

Each floor now has a **department board**: a live roster (staff seated on
that floor, the subset waiting on a permission prompt, the subset running a
tool) plus a manual free-text notes field, toggled from a new "Board" button
in the bottom toolbar. This is Phase 3 of the 4-phase multi-floor
initiative — Phase 4 (stairs/elevator + presets) is the only piece left.

## 2. Design decisions

- **Reused the exact status-text logic the canvas overlay uses**, instead of
  writing a second implementation. `ToolOverlay.tsx` had a private
  `getActivityText` function; extracted it to `office/toolUtils.ts` as
  `getAgentActivityText` so both surfaces call the same code. Any future
  change to status wording (e.g. a new bubble type) updates both
  automatically instead of risking drift between "what the overlay says"
  and "what the board says."
- **Pure derivation, separate from rendering.** `office/departmentBoard.ts`
  exports `deriveDepartmentBoard(characters, floorId, agentTools)` — no
  React, no DOM, just a function from live state to `{staff, helpWanted,
openItems}`. `DepartmentBoard.tsx` only renders what that function
  returns. This follows the project's own testing constraint
  (`CLAUDE.md`: "Rely on Playwright E2E for UI behavior. Do not write
  webview UI unit tests for user-facing features.") — the derivation is
  pure logic, not UI, so it gets a normal unit test suite
  (`departmentBoard.test.ts`, 9 cases), while the actual panel
  rendering/toggle behavior is covered by e2e only, matching how
  `layoutSerializer.test.ts` and `petEntity.test.ts` already draw that same
  line in this codebase.
- **Three lists, not a partition.** An agent can be seated (staff), waiting
  on approval (help wanted), and mid-tool (open items) simultaneously — the
  three arrays can all contain the same entry. Verified explicitly in both
  the unit tests and the e2e test.
- **Notes ride the same persistence path as floors**, not a separate
  mechanism: `OfficeFloor.notes?: string` on the v2 document, threaded
  through `FloorRuntime`, `loadDocument`/`getDocument`, and a new
  `getFloorNotes`/`setFloorNotes` pair on `OfficeState`. Saved through the
  existing debounced `saveDocument()` — no new save path, no new IPC
  message type. Deliberately **not** wired into the undo/redo or
  `isDirty`/EditActionBar machinery: notes are a live workspace field, not
  a layout edit, and available whether or not the layout editor is even
  open.

## 3. A real bug found while extracting the shared status-text function

Moving `getAgentActivityText` out of `ToolOverlay.tsx` and into
`toolUtils.ts` broke the webview build with a `Cannot find name 'window'`
error inside `toolUtils.ts` — but only when compiled as part of the test
project (`tsconfig.node.json`), not the app project (`tsconfig.app.json`).

Root cause: `tsconfig.node.json` (which typechecks everything under
`webview-ui/test/`) has `"lib": ["ES2023"]` — no DOM — because every
existing test file only imports pure logic. My new
`departmentBoard.test.ts` imports `departmentBoard.ts`, which imports
`toolUtils.ts` for `getAgentActivityText` — and `toolUtils.ts` also
happened to contain `defaultZoom()`, a DOM-touching function
(`window.devicePixelRatio`) unrelated to anything department-board related.
TypeScript project references check per-file, not per-export, so importing
_any_ export from `toolUtils.ts` pulled the whole file — DOM reference
included — into the no-DOM test project.

Fixed by extracting `defaultZoom()` into its own file
(`office/zoomUtils.ts`), leaving `toolUtils.ts` fully DOM-free. This is a
real structural improvement independent of the department board work:
`toolUtils.ts` was quietly mixing pure logic with a browser-API call, and
the only reason it hadn't caused a problem yet is that nothing pure had
tried to import from the same file before.

## 4. What changed, by file

- **`office/toolUtils.ts`** — added `getAgentActivityText` (moved from
  `ToolOverlay.tsx`) and exported `WAITING_INPUT_ACTIVITY_TEXT` (was a
  private constant, now shared since `ToolOverlay.tsx` still needs it for
  the sub-agent label branch that doesn't go through the shared function).
  Removed `defaultZoom` (moved out).
- **`office/zoomUtils.ts`** (new) — just `defaultZoom()`, DOM-touching,
  isolated from the pure-logic file.
- **`office/departmentBoard.ts`** (new) — `deriveDepartmentBoard` and the
  `DepartmentBoardEntry`/`DepartmentBoardData` types.
- **`office/types.ts`** — `OfficeFloor.notes?: string`.
- **`office/layout/layoutSerializer.ts`** — `migrateToDocument` carries
  `notes` through for v2 documents (omitted when empty).
- **`office/engine/officeState.ts`** — `FloorRuntime.notes: string`;
  `buildFloorRuntime` accepts and defaults it; `getDocument()` includes it
  (only when non-empty); new `getFloorNotes(id)` / `setFloorNotes(id,
notes)`.
- **`office/components/ToolOverlay.tsx`** — private `getActivityText`
  removed, now imports `getAgentActivityText` + `WAITING_INPUT_ACTIVITY_TEXT`
  from `toolUtils.ts`. No behavior change.
- **`components/DepartmentBoard.tsx`** (new) — the panel: three roster
  sections (dot-colored using the same `--color-status-permission` /
  `--color-status-active` tokens `ToolOverlay` uses) + a notes textarea.
  Local `draft` state resets only when the _viewed floor_ changes, not on
  every notes-prop update, so it doesn't clobber in-progress typing.
- **`components/BottomToolbar.tsx`** — new "Board" toggle button, same
  pattern as the existing Layout/Settings toggles.
- **`hooks/useEditorActions.ts`** — new `handleFloorNotesChange(floorId,
notes)`: calls `officeState.setFloorNotes` then the existing debounced
  `saveDocument()`. No undo/redo/isDirty interaction (see §2).
- **`App.tsx`** — `isDepartmentBoardOpen` state, `DepartmentBoard` rendered
  alongside `ToolOverlay` (same `!isDebugMode` branch), derives its data
  each render from `officeState.characters` + `agentTools` — no extra
  polling loop. This mirrors how `DebugView` already reads
  `officeState.characters` directly at render time, trusting that every
  server message that changes agent state also triggers a `setState`
  somewhere in `useExtensionMessages.ts` (verified: every
  `showWaitingBubble`/`showPermissionBubble` call site is paired with a
  `setAgentStatuses`/`setAgentTools` call in the same message handler
  branch, so a re-render always follows a state change).

## 5. New e2e test — and a real lesson about VS Code panel lifecycle

`e2e/tests/claude/hooks-off/lifecycle.spec.ts` › _"department board: live
roster, notes persist, scoped to viewed floor"_ spawns an agent running a
tool, opens the board, confirms it appears in Staff + Open Items (not Help
Wanted) with matching status text, types a note, and confirms it lands in
`layout.json` on disk.

The first version of this test tried to verify notes _survive a VS Code
panel close/reopen_, using the same `closeBottomPanel` +
`openPixelAgentsPanel` helper pair the existing panel-restore test uses.
It failed consistently (not flaky — reproduced twice, second run in 39s)
with the board panel simply never reappearing after the second "Board"
click. Debug instrumentation (`.count()` before and after the click) showed
the real cause: the panel was **already open** before the click
(`preClickCount: 1`), so the click closed it (`postClickCount: 0`) — i.e.
`closeBottomPanel` + `openPixelAgentsPanel` (View: Toggle Panel /
Pixel Agents: Show Panel) does not reliably force a fresh webview remount
the way this test assumed; local UI toggle state can survive it.

Rather than fight that ambiguity (whether VS Code retains or recreates the
webview here isn't something this feature needs to guarantee either way),
the test was simplified to verify the actual contract that matters: notes
land in the persisted `layout.json` document. Same pattern the Phase 1
floor-rename test already uses for the same reason. Removed the
close/reopen dance and the now-unused `closeBottomPanel` import entirely.

## 6. Verification

| Check                                              | Result                                                                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run compile`                                  | clean, exit 0 (after the `toolUtils.ts`/DOM fix in §3)                                                                                                |
| Server unit tests                                  | 213/213                                                                                                                                               |
| Webview unit tests                                 | 50/50 (41 previous + 9 new `departmentBoard.test.ts`)                                                                                                 |
| New e2e test, standalone reruns (`--retries=0`)    | 2/2 clean, 16.5s then 15.1s                                                                                                                           |
| Full `hooks-off/lifecycle.spec.ts` file (14 tests) | 13 clean + 1 pre-existing flaky (unrelated: "sub-agent permission bubble... heuristic timer", already flagged flaky in the Phase 1 report) + 0 failed |
| `npm run e2e:inventory`                            | 51 → 52 tests                                                                                                                                         |
| `npx eslint` on all touched files                  | clean                                                                                                                                                 |
| Manual browser smoke test                          | see §6.1                                                                                                                                              |

### 6.1 Manual browser smoke test

The automated checks above all run against source/build output; none of
them open the actual app. To rule out a mismatch between "the build
compiles" and "the feature renders," ran the standalone CLI directly and
drove it with Playwright.

One wrinkle: `node dist/cli.js` first attaches to any server already
listed in `~/.pixel-agents/server.json` instead of starting a new one —
useful for the multi-window case, but it meant the first attempt reused
the long-running VS Code extension-host process (up ~1 day, `embedded:
true`, no static file serving → `/` 404s). That process predates this
session's rebuild and won't pick these changes up until the VS Code
window is reloaded. Worked around it for the test by launching with an
isolated `HOME` so the CLI couldn't find that lockfile and started a
genuine standalone instance (`embedded: false`, static serving on) on
its own port instead.

Against that instance:

- Initial load — wood-plank floor and checkerboard floor both render
  (Phase 2 patterns), zero console errors.
- **Board** button opens the department board panel — Help Wanted /
  Open Items / per-floor Notes textarea all present, matching this
  phase's feature.
- **Layout** button shows **+ Floor** and the **Floor 1** selector
  (Phase 1 multi-floor controls) alongside the floor/wall/furniture
  tools.

Confirms the built output actually matches source, independent of the
unit/e2e suites. Take-away for anyone re-checking this: if the app looks
stale in a long-running VS Code window, that's the extension host's
in-memory JS, not the on-disk build — reload the window rather than
rebuilding again.

## 7. Follow-ups

- **Phase 4** — stairs/elevator visuals and named-floor presets. Last phase
  of the initiative.
- The VS Code panel close/reopen lifecycle (§5) is worth understanding
  properly at some point — whether it retains or recreates the webview
  seems to depend on something not yet characterized, and the existing
  panel-restore e2e test's comments assert the opposite of what was
  observed here. Not blocking (nothing in this feature depends on the
  answer), but a latent question for whoever next touches webview restore
  behavior.
