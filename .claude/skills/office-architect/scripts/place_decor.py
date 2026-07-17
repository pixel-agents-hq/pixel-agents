#!/usr/bin/env python3
"""Add a handful of accent decor items (plants, paintings, a clock, a bin,
bookshelves, ...) into a floor WITHOUT clearing anything first — unlike
place_lounge.py, this is additive-only. Use it on a room that already has
desks/chairs/a meeting table you must keep, and that still has genuinely
empty tiles for a few accent pieces.

Every item is validated (bounds + overlap against everything already on
the floor, including items requested earlier in the same invocation)
before anything is written. If any item would collide or go out of
bounds, NOTHING is written and the problems are printed instead — fix
the coordinates and re-run rather than get a partially-placed room.

Wall-mounted decor (paintings, clock, hanging plant, bookshelves) needs
its bottom row on an actual wall tile. For the standard two-room
template's top wall (row 0) that means passing `--item TYPE:COL:-1`
(row -1) since these floors' rooms start at interior row 1 — see the
comment in place_lounge.py's build_lounge() for why.

Examples:
    python3 place_decor.py --floor floor-1 \\
        --item PLANT:14:4 --item HANGING_PLANT:10:-1 --item BIN:12:8
    python3 place_decor.py --sample
"""
import argparse
import json
import sys

from office_lib import (
    DEFAULT_LAYOUT_PATH,
    find_floor,
    load_catalog,
    load_doc,
    save_doc,
    two_room_layout,
    uid,
    validate_layout,
)


def parse_item(spec):
    parts = spec.split(":")
    if len(parts) < 3:
        raise ValueError(f"--item {spec!r} must be TYPE:COL:ROW (optionally TYPE:left:COL:ROW form not "
                          "supported — use the mirrored type id directly, e.g. SOFA_SIDE:left:COL:ROW "
                          "is ambiguous; pass mirrored types as a single TYPE token like 'SOFA_SIDE:left' "
                          "followed by :COL:ROW, i.e. 'SOFA_SIDE:left:5:4')")
    *type_parts, col_s, row_s = parts
    type_id = ":".join(type_parts)
    return type_id, int(col_s), int(row_s)


def build_items(specs):
    items = []
    for spec in specs:
        type_id, col, row = parse_item(spec)
        items.append({"uid": uid(), "type": type_id, "col": col, "row": row})
    return items


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--floor")
    p.add_argument("--item", action="append", default=[], dest="items",
                    help="TYPE:COL:ROW, repeatable. Row may be negative for wall mounts.")
    p.add_argument("--layout-path", default=DEFAULT_LAYOUT_PATH)
    p.add_argument("--output", choices=["json", "human"], default="human")
    p.add_argument("--dry-run", action="store_true",
                    help="Validate against the real floor but don't write the file")
    p.add_argument("--sample", action="store_true", help="Validate against a synthetic room, no file needed")
    args = p.parse_args()

    catalog = load_catalog()

    if args.sample:
        layout = two_room_layout()
        specs = args.items or ["PLANT:3:4", "HANGING_PLANT:2:-1"]
        new_items = build_items(specs)
        layout["furniture"] = new_items
        problems = validate_layout(layout, catalog)
        if args.output == "json":
            print(json.dumps({"requested": len(new_items), "problems": problems}))
        else:
            if problems:
                print("Sample found problems:\n- " + "\n- ".join(problems))
            else:
                print(f"Sample: would place {len(new_items)} decor item(s) cleanly. No file written.")
        return 1 if problems else 0

    if not args.floor:
        p.error("--floor is required (unless --sample)")
    if not args.items:
        p.error("at least one --item is required (unless --sample)")

    doc = load_doc(args.layout_path)
    floor = find_floor(doc, args.floor)
    layout = floor["layout"]

    new_items = build_items(args.items)
    candidate_furniture = layout["furniture"] + new_items
    candidate_layout = dict(layout)
    candidate_layout["furniture"] = candidate_furniture
    problems = validate_layout(candidate_layout, catalog)

    if problems:
        if args.output == "json":
            print(json.dumps({"placed": 0, "problems": problems}))
        else:
            print(f"Refusing to place {len(new_items)} decor item(s) on {args.floor!r} — "
                  f"{len(problems)} problem(s) would result:")
            for prob in problems:
                print(f"  - {prob}")
            print("Nothing written. Adjust --item coordinates and re-run.")
        return 1

    if args.dry_run:
        if args.output == "json":
            print(json.dumps({"placed": len(new_items), "dry_run": True}))
        else:
            print(f"Dry run OK: {len(new_items)} decor item(s) would place cleanly on {args.floor!r}. "
                  "No file written.")
        return 0

    layout["furniture"] = candidate_furniture
    save_doc(doc, args.layout_path)

    if args.output == "json":
        print(json.dumps({"placed": len(new_items)}))
    else:
        print(f"Placed {len(new_items)} decor item(s) on {args.floor!r}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
