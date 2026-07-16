#!/usr/bin/env python3
"""Place a grid of desk+PC+chair workstations into one side of a floor's
two-room layout, auto-sized to a given agent/worker count. Idempotent:
re-running with a new --count clears and re-packs that room's furniture
rather than piling up duplicates.

Examples:
    python3 place_workspace.py --floor floor-1 --side left --count 3
    python3 place_workspace.py --floor floor-1 --side right --count 8
    python3 place_workspace.py --sample
"""
import argparse
import json
import sys

from office_lib import (
    DEFAULT_LAYOUT_PATH,
    clear_room_furniture,
    find_floor,
    footprint,
    infer_divider_col,
    load_catalog,
    load_doc,
    room_bounds,
    save_doc,
    two_room_layout,
    uid,
)

GAP_X = 1
GAP_Y = 1


def pack_desks(catalog, col_lo, col_hi, row_lo, row_hi, count):
    desk_w, desk_h = footprint(catalog, "DESK_FRONT")
    # WOODEN_CHAIR_BACK, not _FRONT: the chair sits BELOW the desk, so the
    # seated character must face UP into it. _FRONT's manifest hardcodes
    # orientation "front" (always faces down/viewer, priority over any
    # desk-adjacency check) which puts the character's back to the
    # computer. _BACK hardcodes orientation "back" -> faces up, matching
    # how the desk sits above it. Same footprint as _FRONT (1x2).
    chair_w, chair_h = footprint(catalog, "WOODEN_CHAIR_BACK")
    # Chair tucked one row into the desk: both DESK_FRONT and WOODEN_CHAIR_BACK
    # have a backgroundTiles=1 row (legs/back edge) that's exempt from
    # collision checks (getPlacementBlockedTiles()/canPlaceFurniture() in the
    # real app), so their background rows can share a tile. This is the
    # confirmed-correct spacing (scooted in, not floating a row below).
    chair_row_offset = desk_h - 1
    last_used_row_offset = chair_row_offset + chair_h - 1
    unit_w = desk_w + GAP_X
    unit_h = last_used_row_offset + 1 + GAP_Y
    room_w = col_hi - col_lo + 1
    per_row = max(1, (room_w + GAP_X) // unit_w)

    items = []
    for i in range(count):
        row_idx, col_idx = divmod(i, per_row)
        x = col_lo + col_idx * unit_w
        y = row_lo + row_idx * unit_h
        if x + desk_w - 1 > col_hi or y + last_used_row_offset > row_hi:
            break
        items.append({"uid": uid(), "type": "DESK_FRONT", "col": x, "row": y})
        items.append({"uid": uid(), "type": "PC_FRONT_OFF", "col": x + 1, "row": y})
        items.append({"uid": uid(), "type": "WOODEN_CHAIR_BACK", "col": x + 1, "row": y + chair_row_offset})
    placed = len(items) // 3
    return items, placed


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--floor", help="Floor id to place into")
    p.add_argument("--side", choices=["left", "right"], default="left")
    p.add_argument("--count", type=int, default=1, help="Number of workstations (desk+PC+chair) wanted")
    p.add_argument("--layout-path", default=DEFAULT_LAYOUT_PATH)
    p.add_argument("--output", choices=["json", "human"], default="human")
    p.add_argument("--sample", action="store_true")
    args = p.parse_args()

    catalog = load_catalog()

    if args.sample:
        layout = two_room_layout()
        col_lo, col_hi, row_lo, row_hi = room_bounds(layout, infer_divider_col(layout), args.side)
        items, placed = pack_desks(catalog, col_lo, col_hi, row_lo, row_hi, args.count or 3)
        layout["furniture"] = items
        if args.output == "json":
            print(json.dumps({"requested": args.count or 3, "placed": placed, "furniture": items}))
        else:
            print(f"Sample: requested {args.count or 3}, placed {placed} workstation(s) in a "
                  f"{layout['cols']}x{layout['rows']} room. No file written.")
        return 0

    if not args.floor:
        p.error("--floor is required (unless --sample)")

    doc = load_doc(args.layout_path)
    floor = find_floor(doc, args.floor)
    layout = floor["layout"]
    divider_col = infer_divider_col(layout)
    clear_room_furniture(layout, divider_col, args.side)
    col_lo, col_hi, row_lo, row_hi = room_bounds(layout, divider_col, args.side)
    items, placed = pack_desks(catalog, col_lo, col_hi, row_lo, row_hi, args.count)
    layout["furniture"].extend(items)
    save_doc(doc, args.layout_path)

    if args.output == "json":
        print(json.dumps({"requested": args.count, "placed": placed}))
    else:
        print(f"Placed {placed}/{args.count} workstation(s) on the {args.side} side of {args.floor!r}.")
        if placed < args.count:
            print(f"Room too small for {args.count - placed} more — grow the floor or split across "
                  "both sides.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
