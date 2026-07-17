#!/usr/bin/env python3
"""Carve an ADDITIONAL walled room into an existing floor's already-VOID
tile space — for growing a floor from 2 rooms to 3+ without touching what's
already there. Unlike add_floor.py (which builds a brand new floor from the
fixed two-room template), this mutates one floor's tile grid in place,
adding a room into empty (VOID) space it already has.

Refuses to write anything if any target tile isn't currently VOID, so it
can't silently clobber an existing room, wall, or floating wall-mounted
decor. Prints the new room's interior bounds (col_lo/col_hi/row_lo/row_hi)
on success — feed those straight into place_decor.py --item TYPE:COL:ROW
calls to furnish it.

Examples:
    # A self-contained room, no connection to anything else on the floor:
    python3 add_room.py --floor floor-1 --row 1 --col 3 --width 12 --height 8 \\
        --tile FLOOR_3 --color-h 140 --color-s 30 --color-b -30 --color-c -40

    # Same, but with a 2-tile doorway gap in the bottom wall:
    python3 add_room.py --floor floor-1 --row 1 --col 3 --width 12 --height 8 \\
        --door 7,8 --door 8,8

    python3 add_room.py --sample
"""
import argparse
import json
import sys

from office_lib import (
    DEFAULT_LAYOUT_PATH,
    carve_room,
    find_floor,
    load_doc,
    resolve_tile_value,
    save_doc,
)


def parse_door(spec):
    parts = spec.split(",")
    if len(parts) != 2:
        raise ValueError(f"--door {spec!r} must be COL,ROW")
    return int(parts[0]), int(parts[1])


def make_sample_layout():
    cols, rows = 20, 20
    return {
        "version": 1,
        "cols": cols,
        "rows": rows,
        "tiles": [255] * (cols * rows),
        "tileColors": [None] * (cols * rows),
        "furniture": [],
    }


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--floor", help="Floor id to carve into")
    p.add_argument("--row", type=int, help="Outer top-left row of the room's wall rectangle")
    p.add_argument("--col", type=int, help="Outer top-left col of the room's wall rectangle")
    p.add_argument("--width", type=int, help="Full rectangle width, walls included (>= 3)")
    p.add_argument("--height", type=int, help="Full rectangle height, walls included (>= 3)")
    p.add_argument("--tile", default="FLOOR_3",
                   help="Interior floor tile: a number or FLOOR_1..FLOOR_9 (default FLOOR_3)")
    p.add_argument("--color-h", type=int, default=140, help="tileColors hue (default 140, a green kitchen tone)")
    p.add_argument("--color-s", type=int, default=30, help="tileColors saturation (default 30)")
    p.add_argument("--color-b", type=int, default=-30, help="tileColors brightness (default -30)")
    p.add_argument("--color-c", type=int, default=-40, help="tileColors contrast (default -40)")
    p.add_argument("--door", action="append", default=[], dest="doors",
                   help="COL,ROW on the room's border to carve as a doorway gap instead of wall; repeatable")
    p.add_argument("--layout-path", default=DEFAULT_LAYOUT_PATH)
    p.add_argument("--output", choices=["json", "human"], default="human")
    p.add_argument("--sample", action="store_true", help="Run against a throwaway in-memory void grid; makes no changes")
    args = p.parse_args()

    tile_value = resolve_tile_value(args.tile)
    color = {"h": args.color_h, "s": args.color_s, "b": args.color_b, "c": args.color_c}
    doors = [parse_door(d) for d in args.doors]

    if args.sample:
        layout = make_sample_layout()
        row = args.row if args.row is not None else 2
        col = args.col if args.col is not None else 2
        width = args.width if args.width is not None else 10
        height = args.height if args.height is not None else 8
        bounds = carve_room(layout, row, col, width, height, tile_value, color, doors)
        if args.output == "json":
            print(json.dumps({"bounds": bounds}))
        else:
            print(f"Sample: would carve a {width}x{height} room at (col={col}, row={row}); "
                  f"interior bounds {bounds}. No file written.")
        return 0

    if not args.floor:
        p.error("--floor is required (unless --sample)")
    if args.row is None or args.col is None or args.width is None or args.height is None:
        p.error("--row, --col, --width, and --height are all required (unless --sample)")

    doc = load_doc(args.layout_path)
    floor = find_floor(doc, args.floor)
    layout = floor["layout"]

    try:
        bounds = carve_room(layout, args.row, args.col, args.width, args.height, tile_value, color, doors)
    except ValueError as exc:
        print(f"Refusing to carve room on {args.floor!r}: {exc}")
        return 1

    save_doc(doc, args.layout_path)

    if args.output == "json":
        print(json.dumps({"floorId": args.floor, "bounds": bounds}))
    else:
        print(f"Carved a {args.width}x{args.height} room into {args.floor!r} at "
              f"(col={args.col}, row={args.row}).")
        print(f"Interior bounds: col {bounds['col_lo']}-{bounds['col_hi']}, "
              f"row {bounds['row_lo']}-{bounds['row_hi']}.")
        print(f"Saved to {args.layout_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
