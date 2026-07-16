#!/usr/bin/env python3
"""Add a new floor to ~/.pixel-agents/layout.json using the standard
two-room (wall + doorway) template.

Examples:
    python3 add_floor.py --name "Engineering"
    python3 add_floor.py --name "Design" --cols 24 --rows 13
    python3 add_floor.py --sample
"""
import argparse
import sys

from office_lib import DEFAULT_LAYOUT_PATH, load_doc, new_floor_id, save_doc, two_room_layout


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--name", help="Floor name shown in the floor switcher")
    p.add_argument("--layout-path", default=DEFAULT_LAYOUT_PATH)
    p.add_argument("--cols", type=int, default=20)
    p.add_argument("--rows", type=int, default=11)
    p.add_argument("--divider-col", type=int, default=None, help="Default: cols // 2 - 1")
    p.add_argument("--notes", default="", help="Initial Department Board notes text")
    p.add_argument("--output", choices=["json", "human"], default="human")
    p.add_argument("--sample", action="store_true", help="Run against a throwaway in-memory doc and print the result; makes no changes")
    args = p.parse_args()

    if args.sample:
        args.name = args.name or "Sample Floor"
        doc = {"version": 2, "layoutRevision": 1, "activeFloorId": "floor-1",
               "floors": [{"id": "floor-1", "name": "Floor 1",
                           "layout": two_room_layout(args.cols, args.rows)}]}
    elif not args.name:
        p.error("--name is required (unless --sample)")
    else:
        doc = load_doc(args.layout_path)

    divider_col = args.divider_col if args.divider_col is not None else args.cols // 2 - 1
    floor = {
        "id": new_floor_id(),
        "name": args.name,
        "layout": two_room_layout(args.cols, args.rows, divider_col),
    }
    if args.notes:
        floor["notes"] = args.notes
    doc["floors"].append(floor)

    if not args.sample:
        save_doc(doc, args.layout_path)

    if args.output == "json":
        print(__import__("json").dumps({"floorId": floor["id"], "name": floor["name"]}))
    else:
        verb = "Would add" if args.sample else "Added"
        print(f"{verb} floor {floor['id']!r} ({floor['name']}), {args.cols}x{args.rows}, "
              f"divider at col {divider_col}.")
        if not args.sample:
            print(f"Saved to {args.layout_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
