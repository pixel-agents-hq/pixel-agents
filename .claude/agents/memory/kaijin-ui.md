# kaijin-ui — memory

Dated, append-only. One line per lesson: `- [YYYY-MM-DD] lesson — why it matters.`

- [2026-07-17] Furniture/tile overlap checks must exempt an item's own `backgroundTiles` rows — a chair's back-row and a desk's leg-row can legitimately share a tile. A validator that doesn't know this flags correct manual layouts as broken (found via office-architect's Engineering-floor validator bug).
