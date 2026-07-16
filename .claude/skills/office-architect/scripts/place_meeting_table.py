#!/usr/bin/env python3
"""Place a meeting table sized to seat N people into one side of a floor.
Chairs flank the table left/right (WOODEN_CHAIR_SIDE on the left,
WOODEN_CHAIR_SIDE:left mirrored on the right — matches the real app's own
convention). Wraps to multiple tables if N needs more length than the
room allows.

Examples:
    python3 place_meeting_table.py --floor floor-1 --side left --seats 4
    python3 place_meeting_table.py --sample --seats 6
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

TABLE_TYPE = "TABLE_FRONT"


def pack_meeting_table(catalog, col_lo, col_hi, row_lo, row_hi, seats):
    table_w, table_h = footprint(catalog, TABLE_TYPE)
    chair_w, chair_h = footprint(catalog, "WOODEN_CHAIR_SIDE")
    seats_per_side = max(1, table_h // chair_h)
    seats_per_table = seats_per_side * 2

    items = []
    placed_seats = 0
    x = col_lo + 1  # leave room for the left-side chair column
    while placed_seats < seats:
        if x + table_w - 1 > col_hi - 1 or row_lo + table_h - 1 > row_hi:
            break
        y = row_lo
        items.append({"uid": uid(), "type": TABLE_TYPE, "col": x, "row": y})
        this_table_seats = min(seats_per_table, seats - placed_seats)
        for i in range(this_table_seats):
            side_index, pair_index = divmod(i, 2)
            row = y + side_index * chair_h
            if pair_index == 0:
                items.append({"uid": uid(), "type": "WOODEN_CHAIR_SIDE", "col": x - 1, "row": row})
            else:
                items.append({"uid": uid(), "type": "WOODEN_CHAIR_SIDE:left", "col": x + table_w, "row": row})
        placed_seats += this_table_seats
        x += table_w + 3  # next table needs its own flanking chair columns

    return items, placed_seats


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--floor")
    p.add_argument("--side", choices=["left", "right"], default="left")
    p.add_argument("--seats", type=int, default=4)
    p.add_argument("--layout-path", default=DEFAULT_LAYOUT_PATH)
    p.add_argument("--output", choices=["json", "human"], default="human")
    p.add_argument("--sample", action="store_true")
    args = p.parse_args()

    catalog = load_catalog()

    if args.sample:
        layout = two_room_layout()
        col_lo, col_hi, row_lo, row_hi = room_bounds(layout, infer_divider_col(layout), args.side)
        items, placed = pack_meeting_table(catalog, col_lo, col_hi, row_lo, row_hi, args.seats)
        if args.output == "json":
            print(json.dumps({"requested": args.seats, "placed": placed, "furniture": items}))
        else:
            print(f"Sample: requested {args.seats} seat(s), placed {placed}. No file written.")
        return 0

    if not args.floor:
        p.error("--floor is required (unless --sample)")

    doc = load_doc(args.layout_path)
    floor = find_floor(doc, args.floor)
    layout = floor["layout"]
    divider_col = infer_divider_col(layout)
    clear_room_furniture(layout, divider_col, args.side)
    col_lo, col_hi, row_lo, row_hi = room_bounds(layout, divider_col, args.side)
    items, placed = pack_meeting_table(catalog, col_lo, col_hi, row_lo, row_hi, args.seats)
    layout["furniture"].extend(items)
    save_doc(doc, args.layout_path)

    if args.output == "json":
        print(json.dumps({"requested": args.seats, "placed": placed}))
    else:
        print(f"Seated {placed}/{args.seats} on the {args.side} side of {args.floor!r}.")
        if placed < args.seats:
            print(f"Room too small for {args.seats - placed} more seat(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
