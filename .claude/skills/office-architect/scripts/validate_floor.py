#!/usr/bin/env python3
"""Validate a floor (or every floor) for out-of-bounds or overlapping
furniture before you consider the layout done. Exits 1 if any floor has
problems.

Examples:
    python3 validate_floor.py --floor floor-1
    python3 validate_floor.py --all
    python3 validate_floor.py --sample
"""
import argparse
import json
import sys

from office_lib import DEFAULT_LAYOUT_PATH, find_floor, load_catalog, load_doc, two_room_layout, validate_layout


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = p.add_mutually_exclusive_group()
    group.add_argument("--floor", help="Validate just this floor id")
    group.add_argument("--all", action="store_true", help="Validate every floor in the document")
    p.add_argument("--layout-path", default=DEFAULT_LAYOUT_PATH)
    p.add_argument("--output", choices=["json", "human"], default="human")
    p.add_argument("--sample", action="store_true")
    args = p.parse_args()

    catalog = load_catalog()

    if args.sample:
        layout = two_room_layout()
        layout["furniture"] = [
            {"uid": "a", "type": "DESK_FRONT", "col": 2, "row": 4},
            {"uid": "b", "type": "DESK_FRONT", "col": 3, "row": 4},  # deliberately overlapping
        ]
        problems = validate_layout(layout, catalog)
        print(json.dumps({"problems": problems}) if args.output == "json" else
              ("Sample found (expected) problems:\n- " + "\n- ".join(problems)))
        return 1 if problems else 0

    doc = load_doc(args.layout_path)
    if args.all:
        floors = doc["floors"]
    elif args.floor:
        floors = [find_floor(doc, args.floor)]
    else:
        p.error("one of --floor or --all is required (unless --sample)")
        return 2

    any_problems = False
    results = {}
    for fl in floors:
        problems = validate_layout(fl["layout"], catalog)
        results[fl["id"]] = problems
        any_problems = any_problems or bool(problems)

    if args.output == "json":
        print(json.dumps(results))
    else:
        for floor_id, problems in results.items():
            if not problems:
                print(f"{floor_id}: OK")
            else:
                print(f"{floor_id}: {len(problems)} problem(s)")
                for prob in problems:
                    print(f"  - {prob}")

    return 1 if any_problems else 0


if __name__ == "__main__":
    sys.exit(main())
