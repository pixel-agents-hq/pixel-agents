#!/usr/bin/env python3
"""Place a fixed lounge+flowers preset (sofa square around a coffee table,
plants, wall art) into one side of a floor. Not agent-count-scaled — this
is decorative, unlike place_workspace.py / place_meeting_table.py.

Examples:
    python3 place_lounge.py --floor floor-1 --side right
    python3 place_lounge.py --sample
"""
import argparse
import json
import sys

from office_lib import (
    DEFAULT_LAYOUT_PATH,
    clear_room_furniture,
    find_floor,
    infer_divider_col,
    load_doc,
    room_bounds,
    save_doc,
    two_room_layout,
    uid,
)


def build_lounge(col_lo, row_lo):
    """Coordinates relative to the room's top-left interior corner. The
    three wall-mounted items (canPlaceOnWalls) are placed at row -1 so
    their bottom edge lands on the actual outer wall tile (row 0) — the
    real app's canPlaceFurniture() requires this; placing them flush in
    the first floor row leaves them floating with no wall contact."""
    x, y = col_lo, row_lo
    return [
        {"uid": uid(), "type": "LARGE_PAINTING", "col": x + 1, "row": -1},
        {"uid": uid(), "type": "SMALL_PAINTING_2", "col": x + 5, "row": -1},
        {"uid": uid(), "type": "HANGING_PLANT", "col": x + 7, "row": -1},
        {"uid": uid(), "type": "SOFA_FRONT", "col": x + 3, "row": y + 3},
        {"uid": uid(), "type": "SOFA_SIDE", "col": x + 2, "row": y + 4},
        {"uid": uid(), "type": "SOFA_SIDE:left", "col": x + 5, "row": y + 4},
        {"uid": uid(), "type": "SOFA_BACK", "col": x + 3, "row": y + 6},
        {"uid": uid(), "type": "COFFEE_TABLE", "col": x + 3, "row": y + 4},
        {"uid": uid(), "type": "COFFEE", "col": x + 3, "row": y + 5},
        {"uid": uid(), "type": "LARGE_PLANT", "col": x + 6, "row": y + 1},
        {"uid": uid(), "type": "PLANT", "col": x + 6, "row": y + 5},
        {"uid": uid(), "type": "PLANT_2", "col": x + 7, "row": y + 6},
        {"uid": uid(), "type": "CACTUS", "col": x + 8, "row": y + 2},
        {"uid": uid(), "type": "POT", "col": x + 8, "row": y + 5},
    ]


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--floor")
    p.add_argument("--side", choices=["left", "right"], default="right")
    p.add_argument("--layout-path", default=DEFAULT_LAYOUT_PATH)
    p.add_argument("--output", choices=["json", "human"], default="human")
    p.add_argument("--sample", action="store_true")
    args = p.parse_args()

    if args.sample:
        layout = two_room_layout()
        col_lo, _col_hi, row_lo, _row_hi = room_bounds(layout, infer_divider_col(layout), args.side)
        items = build_lounge(col_lo, row_lo)
        if args.output == "json":
            print(json.dumps({"placed": len(items), "furniture": items}))
        else:
            print(f"Sample: would place {len(items)} lounge/flower items. No file written.")
        return 0

    if not args.floor:
        p.error("--floor is required (unless --sample)")

    doc = load_doc(args.layout_path)
    floor = find_floor(doc, args.floor)
    layout = floor["layout"]
    divider_col = infer_divider_col(layout)
    clear_room_furniture(layout, divider_col, args.side)
    col_lo, col_hi, row_lo, row_hi = room_bounds(layout, divider_col, args.side)
    room_w, room_h = col_hi - col_lo + 1, row_hi - row_lo + 1
    if room_w < 9 or room_h < 8:
        print(f"Room is {room_w}x{room_h}; this preset needs at least 9x8. Skipped.")
        return 1
    items = build_lounge(col_lo, row_lo)
    layout["furniture"].extend(items)
    save_doc(doc, args.layout_path)

    if args.output == "json":
        print(json.dumps({"placed": len(items)}))
    else:
        print(f"Placed {len(items)} lounge/flower items on the {args.side} side of {args.floor!r}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
