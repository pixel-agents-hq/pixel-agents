#!/usr/bin/env python3
"""Set a floor's Department Board notes text.

Examples:
    python3 set_notes.py --floor floor-1 --text "Roster: ..."
    python3 set_notes.py --floor floor-1 --file roster.md
    python3 set_notes.py --sample
"""
import argparse
import sys

from office_lib import DEFAULT_LAYOUT_PATH, find_floor, load_doc, save_doc


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--floor")
    group = p.add_mutually_exclusive_group()
    group.add_argument("--text", help="Literal notes text")
    group.add_argument("--file", help="Path to a text/markdown file whose contents become the notes")
    p.add_argument("--layout-path", default=DEFAULT_LAYOUT_PATH)
    p.add_argument("--sample", action="store_true")
    args = p.parse_args()

    if args.sample:
        print("Sample: set_notes.py --floor floor-1 --text 'Roster: Alice (lead), Bob' "
              "would write that string into floor-1's notes field. No file written.")
        return 0

    if not args.floor:
        p.error("--floor is required (unless --sample)")
    if not args.text and not args.file:
        p.error("one of --text or --file is required (unless --sample)")

    text = args.text
    if args.file:
        with open(args.file) as f:
            text = f.read()

    doc = load_doc(args.layout_path)
    floor = find_floor(doc, args.floor)
    floor["notes"] = text
    save_doc(doc, args.layout_path)
    print(f"Set notes on {args.floor!r} ({len(text)} chars).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
