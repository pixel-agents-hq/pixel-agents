# Multi-Floor Offices

An office can now have more than one **floor** — each a fully independent
grid with its own furniture, seats, agents, and pets. Think of it as a
building: a "Library" floor, an "Engineering" floor, a "CRM" floor, whatever
your workflow needs. Agents are seated on exactly one floor and are only
visible while that floor is the one being viewed.

Single-floor offices are unaffected: the floor switcher stays hidden and the
office behaves exactly as before.

## What it looks like

```
┌──────────────┐
│  + Floor     │   ← only in edit mode
├──────────────┤
│  Engineering │   ← newest floor on top
│  Library     │   ← active floor highlighted
│  Floor 1     │   ← first floor at the bottom, building-style
└──────────────┘
```

The floor switcher renders top-left, above the zoom controls. It stays
hidden entirely while there is only one floor and you're not in edit mode —
the pre-multi-floor look is the default experience.

## Managing floors

All floor operations happen from the **Layout** editor toolbar:

- **Add** — the `+ Floor` button creates an empty floor (bundled default
  layout) and switches to it immediately. Capped at 12 floors
  (`MAX_FLOORS` in `webview-ui/src/constants.ts`).
- **Switch** — click any floor tab. Only characters seated on the viewed
  floor render; everyone else's overlay, tool status, and animation keep
  ticking in the background, they just aren't drawn.
- **Rename** — double-click a floor tab (edit mode only) to get an inline
  text input. Enter commits, Escape cancels. Capped at 24 characters
  (`FLOOR_NAME_MAX_LENGTH`).
- **Delete** — click the `×` once to arm it (turns into `!`), click again
  within 3 seconds to confirm (`FLOOR_DELETE_CONFIRM_TIMEOUT_MS`) — a
  disarming timeout instead of a modal, so an accidental first click never
  destroys a floor. Deleting a floor moves its agents to the first remaining
  floor (re-seated if a free seat exists, otherwise placed on a walkable
  tile) and removes its pets. The last remaining floor can't be deleted.

Undo/redo history is scoped per floor and clears on every floor operation
(add/switch/rename/delete) — the 50-level undo stack from the single-floor
editor never crosses a floor boundary.

## Agents and seats across floors

- A newly spawned agent seats on the floor you're currently viewing.
- Reassigning an agent's seat (drag in edit mode, or the seat picker) can
  target a seat on a **different** floor. Since there's no cross-floor
  pathfinding, the agent teleports (the same matrix-effect spawn/despawn
  visual used for /clear reassignment) directly onto its new seat.
- A restored agent (webview reload, VS Code panel re-create) returns to
  whichever floor its seat lives on — floors are searched by seat id, not
  assumed to be the active floor.
- Right-click "walk to tile" only works on the floor you're currently
  viewing; it does nothing across floors (there's nothing to walk _through_
  between two separate grids).

## Persistence: layout.json v2

The single-grid `OfficeLayout` from pre-multi-floor versions is `version: 1`.
Multi-floor offices persist as a `version: 2` **document**:

```json
{
  "version": 2,
  "activeFloorId": "floor-1",
  "floors": [
    { "id": "floor-1", "name": "Floor 1", "layout": { "...": "v1 OfficeLayout" } },
    { "id": "floor-a1b2c3d4", "name": "Engineering", "layout": { "...": "..." } }
  ]
}
```

- **Migration is automatic and one-way-safe**: any `layout.json` still on
  disk in the old v1 shape is read, wrapped as the single floor of a v2
  document, and re-saved in v2 shape on the next edit. Old exports still
  import cleanly (`migrateToDocument` in
  `webview-ui/src/office/layout/layoutSerializer.ts` accepts both shapes).
- **`activeFloorId`** is restored on reload so you come back to the floor you
  were viewing, not always floor 1.
- Import/export (Settings → Export/Import) both round-trip through the same
  v2 document — importing an old v1 export still works via the same
  migration path (`adapters/vscode/PixelAgentsViewProvider.ts` accepts either
  `version: 1` with `tiles[]` or `version: 2` with `floors[]`).
- Floor structure changes (add/rename/delete) save immediately through the
  existing debounced save path — they aren't undoable, which is why delete
  has its own two-click confirm instead of relying on Ctrl+Z.

## Architecture note

Internally, `OfficeState` now holds one `FloorRuntime` (tile map, seats,
blocked tiles, furniture instances, walkable tiles, pets) per floor, keyed by
floor id. The pre-existing single-floor fields (`layout`, `tileMap`, `seats`,
`furniture`, `walkableTiles`, `pets`) are now getters that proxy to the
**active** floor's runtime — every consumer that read `officeState.seats`
directly (pathfinding, hit-testing, the editor) works unchanged. Only the
few call sites that operate across floors (seat lookup during restore,
teleport reassignment, floor CRUD) reach into `floorRuntimes` directly.

## Testing

`e2e/tests/claude/hooks-off/lifecycle.spec.ts` › _"multi-floor: add, switch,
rename and delete floors; persists a v2 document"_ drives the full lifecycle
end to end: single-floor switcher stays hidden → add floor → agent overlay
disappears while the new floor is active → switch back → overlay reappears →
rename via double-click → confirm `layout.json` upgrades to `version: 2` with
both floors named correctly on disk → delete the second floor → switcher
hides again once back to one floor.

## What's next

This is Phase 1 (core multi-floor engine + editor UI). Planned follow-ups:

- **Phase 2** — done, scoped down to floor-tile _patterns_ rather than a
  per-floor theme system. Three new selectable floor patterns (checkerboard,
  wood plank, brick), adapted from JIK-A-4's Interior asset pack, joined the
  existing 9 via the ordinary `floor_N.png` pipeline — no new UI or per-floor
  state. See [`docs/reports/2026-07-16-multi-floor-phase2-report.md`](reports/2026-07-16-multi-floor-phase2-report.md)
  for why a full per-floor theme system (auto-tiled walls included) was
  scoped out for now.
- **Phase 3** — done. Each floor has a department board: a live roster
  (staff / help wanted / open items) plus manual notes, persisted per floor.
  See [`docs/department-board.md`](department-board.md).
- **Phase 4** — stairs/elevator visuals and named-floor presets.
