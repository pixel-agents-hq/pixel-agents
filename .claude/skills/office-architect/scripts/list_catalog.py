#!/usr/bin/env python3
"""List furniture types available for place_workspace.py / place_meeting_table.py
/ place_lounge.py to reference, read live from the repo's manifests (so this
never drifts from what's actually installed).

Examples:
    python3 list_catalog.py
    python3 list_catalog.py --category desks
    python3 list_catalog.py --sample
"""
import argparse
import json
import sys

from office_lib import load_catalog


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--output", choices=["json", "human"], default="human")
    p.add_argument("--sample", action="store_true", help="Same as running with no filters")
    args = p.parse_args()  # --sample and default behave the same; no filters implemented yet

    catalog = load_catalog()
    if args.output == "json":
        print(json.dumps(catalog, indent=2))
    else:
        for type_id, entry in sorted(catalog.items()):
            tags = []
            if entry["canPlaceOnWalls"]:
                tags.append("wall")
            if entry["canPlaceOnSurfaces"]:
                tags.append("surface")
            tag_str = f" [{', '.join(tags)}]" if tags else ""
            print(f"{type_id:24} {entry['footprintW']}x{entry['footprintH']}{tag_str}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
