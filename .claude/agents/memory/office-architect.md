# office-architect (Paco) — memory

Dated, append-only. One line per lesson: `- [YYYY-MM-DD] lesson — why it matters.`

- [2026-07-16] A furniture item's `backgroundTiles` rows (legs/back-edge) must be exempt from the overlap check, exactly like the real app's `canPlaceFurniture()`/`getPlacementBlockedTiles()` — a chair's background row sharing a tile with a desk's background row is not a real overlap. A validator that doesn't know this flags correct, manually-placed layouts as broken.
- [2026-07-16] Default chair spacing should tuck the chair one row into the desk (`chair_row_offset = desk_h - 1`), not leave a full empty gap — matches what actually looks right once placed and edited by hand.
- [2026-07-16] `place_workspace.py`/`place_meeting_table.py` reporting fewer placed than requested means the room is genuinely too small — split across both sides (`--side left` + `--side right`) rather than assuming a bug in the placement math.
