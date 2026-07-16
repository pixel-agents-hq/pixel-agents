"""Shared helpers for the office-architect skill's CLI tools.

Deterministic, stdlib-only. Every tool in this skill imports this module
instead of re-deriving tile math, furniture catalog data, or layout.json
I/O — that duplication is exactly what burns tokens when an LLM has to
hand-write it fresh each time.
"""

import json
import os
import random
import string
import time

WALL = 0
FLOOR_1 = 1
FLOOR_2 = 2

DEFAULT_LAYOUT_PATH = os.path.expanduser("~/.pixel-agents/layout.json")

# Repo root: this file lives at <repo>/.claude/skills/office-architect/scripts/
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
FURNITURE_DIR = os.path.join(_REPO_ROOT, "webview-ui", "public", "assets", "furniture")


# ── Layout document I/O ──────────────────────────────────────────────


def load_doc(path=DEFAULT_LAYOUT_PATH):
    """Load a v2 OfficeDocument. Raises if the file is missing or v1
    (this skill only operates on multi-floor documents)."""
    with open(path) as f:
        doc = json.load(f)
    if doc.get("version") != 2:
        raise ValueError(
            f"{path} is not a v2 multi-floor document (version={doc.get('version')}). "
            "Refusing to guess — back it up and convert it first."
        )
    return doc


def save_doc(doc, path=DEFAULT_LAYOUT_PATH):
    """Atomic write: temp file + rename, same pattern the app itself uses
    (server/src/layoutPersistence.ts) so a crash mid-write can't corrupt
    the live file."""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f)
    os.replace(tmp, path)


def find_floor(doc, floor_id):
    for fl in doc["floors"]:
        if fl["id"] == floor_id:
            return fl
    raise KeyError(f"No floor with id {floor_id!r}. Known floors: "
                    f"{[f['id'] + ':' + f['name'] for f in doc['floors']]}")


def uid():
    return f"f-{int(time.time() * 1000)}-{''.join(random.choices(string.ascii_lowercase + string.digits, k=4))}"


def new_floor_id():
    return f"floor-{''.join(random.choices(string.ascii_lowercase + string.digits, k=8))}"


# ── Furniture catalog (reads the real manifests, not a hardcoded table) ──


def _flatten_members(node, out):
    """Recursively walk a manifest's asset/group tree, collecting every
    leaf asset's {id: {footprintW, footprintH}}. Mirrors the nesting seen
    in real manifests (rotation > state > animation > asset)."""
    if isinstance(node, list):
        for child in node:
            _flatten_members(child, out)
        return
    if not isinstance(node, dict):
        return
    if node.get("type") == "asset":
        out[node["id"]] = {
            "footprintW": node.get("footprintW", 1),
            "footprintH": node.get("footprintH", 1),
            "mirrorSide": bool(node.get("mirrorSide")),
        }
    elif "members" in node:
        _flatten_members(node["members"], out)


def load_catalog(furniture_dir=FURNITURE_DIR):
    """Scan every furniture/*/manifest.json and return a flat
    {type_id: {footprintW, footprintH, canPlaceOnWalls, canPlaceOnSurfaces,
    backgroundTiles}} dict, including group members (e.g. DESK_FRONT from the
    DESK group) and their ':left' mirrored variants where mirrorSide is set."""
    catalog = {}
    if not os.path.isdir(furniture_dir):
        raise FileNotFoundError(
            f"Furniture directory not found at {furniture_dir}. "
            "Is this skill still inside the pixel-agents repo?"
        )
    for name in sorted(os.listdir(furniture_dir)):
        manifest_path = os.path.join(furniture_dir, name, "manifest.json")
        if not os.path.isfile(manifest_path):
            continue
        with open(manifest_path) as f:
            manifest = json.load(f)
        walls = bool(manifest.get("canPlaceOnWalls"))
        surfaces = bool(manifest.get("canPlaceOnSurfaces"))
        bg_rows = int(manifest.get("backgroundTiles") or 0)
        if manifest.get("type") == "asset":
            leaves = {manifest["id"]: {
                "footprintW": manifest.get("footprintW", 1),
                "footprintH": manifest.get("footprintH", 1),
                "mirrorSide": False,
            }}
        else:
            leaves = {}
            _flatten_members(manifest.get("members", []), leaves)
        for type_id, info in leaves.items():
            entry = {
                "footprintW": info["footprintW"],
                "footprintH": info["footprintH"],
                "canPlaceOnWalls": walls,
                "canPlaceOnSurfaces": surfaces,
                "backgroundTiles": bg_rows,
            }
            catalog[type_id] = entry
            if info["mirrorSide"]:
                catalog[f"{type_id}:left"] = entry
    return catalog


def footprint(catalog, type_id):
    entry = catalog.get(type_id)
    if entry is None:
        raise KeyError(f"Unknown furniture type {type_id!r}. Run list_catalog.py to see valid types.")
    return entry["footprintW"], entry["footprintH"]


# ── Two-room template (wall + doorway between two floor-color zones) ────


def two_room_layout(cols=20, rows=11, divider_col=9, door_rows=(4, 5, 6),
                     left_color=None, right_color=None):
    """The wall-divided two-room template used by every floor built this
    session: outer wall border, an inner dividing wall at divider_col with
    a doorway gap at door_rows, FLOOR_1 left of the divider / FLOOR_2 right."""
    left_color = left_color or {"h": 35, "s": 30, "b": 15, "c": 0}
    right_color = right_color or {"h": 25, "s": 45, "b": 5, "c": 10}
    door_rows = set(door_rows)
    tiles, colors = [], []
    for r in range(rows):
        for c in range(cols):
            if r == 0 or r == rows - 1 or c == 0 or c == cols - 1:
                tiles.append(WALL)
                colors.append(None)
            elif c == divider_col and r not in door_rows:
                tiles.append(WALL)
                colors.append(None)
            elif c <= divider_col:
                tiles.append(FLOOR_1)
                colors.append(left_color)
            else:
                tiles.append(FLOOR_2)
                colors.append(right_color)
    return {
        "version": 1,
        "cols": cols,
        "rows": rows,
        "tiles": tiles,
        "tileColors": colors,
        "furniture": [],
    }


def infer_divider_col(layout):
    """Find the internal dividing wall column: the interior column with the
    most WALL tiles across interior rows (a real doorway gap keeps a few
    rows open, so this can't just check one row)."""
    cols, rows = layout["cols"], layout["rows"]
    tiles = layout["tiles"]
    best_col, best_count = None, 0
    for c in range(1, cols - 1):
        count = sum(1 for r in range(1, rows - 1) if tiles[r * cols + c] == WALL)
        if count > best_count:
            best_col, best_count = c, count
    if best_col is None:
        raise ValueError("Could not find an internal dividing wall in this floor's layout")
    return best_col


def room_bounds(layout, divider_col, side):
    """Interior (non-wall) column/row bounds for one side of a two-room
    layout. side='left' -> cols [1, divider_col-1]; side='right' ->
    cols [divider_col+1, cols-2]. Rows always [1, rows-2]."""
    if side == "left":
        col_lo, col_hi = 1, divider_col - 1
    elif side == "right":
        col_lo, col_hi = divider_col + 1, layout["cols"] - 2
    else:
        raise ValueError("side must be 'left' or 'right'")
    return col_lo, col_hi, 1, layout["rows"] - 2


def clear_room_furniture(layout, divider_col, side):
    """Remove furniture whose top-left tile falls within one side's
    bounds. Used so re-running a placement command is idempotent instead
    of piling up duplicates."""
    col_lo, col_hi, row_lo, row_hi = room_bounds(layout, divider_col, side)
    layout["furniture"] = [
        f for f in layout["furniture"]
        if not (col_lo <= f["col"] <= col_hi and row_lo <= f["row"] <= row_hi)
    ]


def overlaps(a_col, a_row, a_w, a_h, b_col, b_row, b_w, b_h):
    return a_col < b_col + b_w and a_col + a_w > b_col and a_row < b_row + b_h and a_row + a_h > b_row


def validate_layout(layout, catalog):
    """Returns a list of human-readable problems (empty if clean): any
    furniture item out of bounds, overlapping another SOLID floor item, or
    of unknown type.

    Overlap is only flagged between two plain floor items (neither
    canPlaceOnWalls nor canPlaceOnSurfaces) — a PC sitting on a desk, a
    coffee mug on a table, or wall decor sharing a tile with a floor plant
    are all intentional in this game's data model (surfaces stack, wall
    items occupy a different visual plane), matching how the real app's
    own canPlaceFurniture() treats them.

    Within that, only each item's NON-background-tile rows count toward the
    collision box — a chair's/desk's `backgroundTiles` rows (its legs/back
    edge) are exempt, exactly like getPlacementBlockedTiles() /
    canPlaceFurniture() in layoutSerializer.ts / editorActions.ts. This is
    why a WOODEN_CHAIR_BACK tucked one row into a DESK_FRONT (only their
    background rows sharing a tile) is valid, not an overlap."""
    problems = []
    cols, rows = layout["cols"], layout["rows"]
    placed = []
    for item in layout["furniture"]:
        entry = catalog.get(item["type"])
        if entry is None:
            problems.append(f"{item['uid']}: unknown type {item['type']!r}")
            continue
        w, h = entry["footprintW"], entry["footprintH"]
        bg = entry.get("backgroundTiles", 0)
        is_solid_floor_item = not entry["canPlaceOnWalls"] and not entry["canPlaceOnSurfaces"]
        # Wall items are checked by their BOTTOM row (must land in-bounds on
        # the wall tile) — the item itself may extend upward past row 0, per
        # the real app's own canPlaceFurniture() in editorActions.ts.
        if entry["canPlaceOnWalls"]:
            bottom_row = item["row"] + h - 1
            out_of_bounds = item["col"] < 0 or item["col"] + w > cols or bottom_row < 0 or bottom_row >= rows
        else:
            out_of_bounds = (
                item["col"] < 0 or item["row"] < 0 or item["col"] + w > cols or item["row"] + h > rows
            )
        if out_of_bounds:
            problems.append(f"{item['uid']} ({item['type']} @ {item['col']},{item['row']}): out of bounds")
        # Effective collision box: skip the item's own background rows.
        eff_row, eff_h = item["row"] + bg, max(h - bg, 0)
        if is_solid_floor_item and eff_h > 0:
            for other_uid, ocol, orow, ow, oh, other_solid in placed:
                if other_solid and oh > 0 and overlaps(item["col"], eff_row, w, eff_h, ocol, orow, ow, oh):
                    problems.append(
                        f"{item['uid']} ({item['type']} @ {item['col']},{item['row']}) overlaps {other_uid}"
                    )
        placed.append((item["uid"], item["col"], eff_row, w, eff_h, is_solid_floor_item))
    return problems
