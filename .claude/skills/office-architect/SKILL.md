---
name: office-architect
description: Build and manage pixel-agents office floors — add floors, place desk/PC workspaces sized to a subagent count, meeting tables, lounge/flower rooms, department notes, and validate layouts. Use when asked to create a new room/floor/department, size a room for a given number of agents, or check a floor for overlapping/out-of-bounds furniture. Operates directly on ~/.pixel-agents/layout.json via deterministic Python — never hand-derive tile coordinates or furniture JSON yourself when this skill applies.
---

# office-architect

## Why this exists

Building a floor by hand means deriving tile-grid coordinates, generating
furniture JSON, checking footprints against the real manifests, and
avoiding overlaps — all mechanical work with no judgment call in it. Doing
that inline burns a full turn of reasoning per floor and is easy to get
subtly wrong (see: the wall-mounted-item row convention below, which was
gotten wrong twice while this skill was built).

Every tool here is stdlib-only Python, deterministic, and safe to call
directly. Your job when using this skill is to decide _what_ to build
(how many desks, which floor, what theme) — not to compute _how_ the JSON
should look. Reach for these scripts instead of writing JSON by hand.

## Scripts (in `scripts/`, run with `python3 <script>.py`)

| Script                                                           | Purpose                                                                                         |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `add_floor.py --name X`                                          | Add a new floor using the standard two-room + dividing-wall + doorway template                  |
| `place_workspace.py --floor ID --side left\|right --count N`     | Pack N desk+PC+chair workstations into a room, auto-sized to fit; reports how many actually fit |
| `place_meeting_table.py --floor ID --side left\|right --seats N` | Place a meeting table seating N (wraps to multiple tables if needed)                            |
| `place_lounge.py --floor ID --side left\|right`                  | Place a fixed sofa+coffee-table+plants preset (not count-scaled)                                |
| `set_notes.py --floor ID --text "..."` or `--file notes.md`      | Write the floor's Department Board notes                                                        |
| `validate_floor.py --floor ID` or `--all`                        | Check for out-of-bounds/overlapping furniture; exit 1 if any floor has problems                 |
| `list_catalog.py`                                                | List every furniture type + footprint, read live from the manifests (never stale)               |

Every script supports `--help` and `--sample` (dry run against an
in-memory example, no file written) — run `--sample` first if you're
unsure what a command will do.

All commands default to `~/.pixel-agents/layout.json`; pass
`--layout-path` to target a different file (e.g. when testing).

## Workflow: build a new department room

1. `list_catalog.py` if you need to check what furniture types exist (usually you won't — the presets below cover the common cases).
2. `add_floor.py --name "<Department Name>"` — note the floor id it prints.
3. Decide room contents based on what the department needs:
   - Individual contributors at computers → `place_workspace.py --side left --count <agent count>`
   - A coordinator + specialists who meet as a group → `place_meeting_table.py --side left --seats <agent count>`
   - Either room can pair with → `place_lounge.py --side right` for a break/social space
4. `set_notes.py --floor ID --text "<roster: who's here and what they do>"`
5. `validate_floor.py --floor ID` — must print `OK` before you report done. If it doesn't, fix the reported problem (don't waive it) and re-validate.
6. Tell the user the floor id/name and that a VS Code reload (or the live Dev Host, if already open) will pick it up.

## Sizing rooms to subagent count

`place_workspace.py`/`place_meeting_table.py` take `--count`/`--seats`
directly — get the real number from the domain's agent roster (e.g. count
how many `cs-*.md` files exist for that team) rather than guessing. If the
tool reports fewer placed than requested, the room is genuinely too small:
either re-run `add_floor.py` with larger `--cols`/`--rows`, or split the
team across both sides of the room (`--side left` and `--side right`).

Re-running a placement command on the same floor+side clears that room's
existing furniture first — it's idempotent, so resizing for a team that
grew from 3 to 7 is just re-running with `--count 7`, not manually
computing a diff.

## Hard rules

- **Always run `validate_floor.py` before reporting a floor done.** A
  script exiting 0 doesn't mean the placement was visually correct —
  validate catches overlaps and out-of-bounds placement the placement
  scripts themselves might still get wrong on a future edit.
- **Wall-mounted items (paintings, bookshelves, clocks, hanging plants)
  are placed with their _bottom_ row on the actual wall tile, which often
  means a negative `row` value** (e.g. `row: -1` for a footprintH=2 item
  mounted on the top wall at row 0). This matches the real app's
  `canPlaceFurniture()` in `webview-ui/src/office/editor/editorActions.ts`
  — placing them flush in the first floor row leaves them with no wall
  contact and is a real bug that shipped once already in this skill's own
  `place_lounge.py` before being caught by validation.
- **Desk chairs must be the variant whose _forced_ orientation matches which
  side of the desk they sit on** — `webview-ui/src/office/layout/layoutSerializer.ts`'s
  `layoutToSeats()` picks facing direction by: 1) the chair's own
  `orientation` field if the manifest sets one (always wins, ignores
  geometry), 2) an adjacent-desk check, 3) default down. `WOODEN_CHAIR_FRONT`
  hardcodes `orientation: "front"` (always faces down/viewer) — placing it
  _below_ a desk (as `place_workspace.py` originally did) makes the seated
  character face away from the computer. `place_workspace.py` now uses
  `WOODEN_CHAIR_BACK` (`orientation: "back"` → always faces up), which is
  correct for a chair below a desk. If you ever add a workstation pattern
  with the chair on a different side of the desk, pick the chair variant
  whose orientation faces that direction — don't assume the adjacency
  fallback will save you, since a chair with `backgroundTiles > 0` (like the
  WOODEN_CHAIR set) puts its seat tile one row past the desk, too far for
  the adjacency check to detect.
- **An item's `backgroundTiles` rows are exempt from overlap checks** —
  matching `getPlacementBlockedTiles()` / `canPlaceFurniture()` in
  `layoutSerializer.ts` / `editorActions.ts`. `DESK_FRONT` and
  `WOODEN_CHAIR_BACK` both have `backgroundTiles: 1`, so a chair tucked one
  row into the desk (only their background/legs rows sharing a tile) is
  correct, scooted-in placement — not an overlap. `validate_layout()` in
  `office_lib.py` computes each item's effective collision box as
  `(row + backgroundTiles, height - backgroundTiles)` before checking
  overlap, for exactly this reason. `place_workspace.py`'s default spacing
  already places the chair this way (`chair_row_offset = desk_h - 1`) — this
  was found and fixed after an earlier version left a full empty row between
  desk and chair, which is _not_ wrong, just looser than the confirmed-good
  tucked-in spacing.
- **Surface-stacking is intentional, not a bug**: a PC on a desk, a coffee
  mug on a table, both occupying the same tile as the furniture beneath
  them, is correct. `validate_layout()` in `office_lib.py` already knows
  this (only flags overlaps between two solid floor items) — don't
  "fix" a surface-stacking overlap you see reported elsewhere.
- **Never edit `~/.pixel-agents/layout.json` by hand when a script here
  covers the operation.** If a script doesn't cover something you need,
  extend `office_lib.py` / add a new script rather than dropping back to
  ad hoc JSON edits.
- These scripts write directly to the live file. If the pixel-agents
  extension (installed or Dev Host) is open and actively watching that
  file, changes should be picked up automatically; if not, a window
  reload (or relaunching the Dev Host) is needed to see them.

## Architecture notes

- `office_lib.py` is the only place that knows about tile math, the
  furniture catalog, and layout.json's shape. Every other script imports
  from it — don't duplicate its logic.
- The furniture catalog is read live from
  `webview-ui/public/assets/furniture/*/manifest.json` (relative to the
  repo root, resolved from this file's own location) — it will never
  drift out of sync with what the app actually ships, even as new
  furniture is added.
- The two-room-with-doorway template (`two_room_layout()` /
  `infer_divider_col()`) matches the floors already built this session
  (HQ, Business Growth) — a floor built any other way (e.g. hand-edited)
  should still work with `infer_divider_col()` as long as it has _some_
  vertical dividing wall with a gap in it.
