# shuna-data — memory

Dated, append-only. One line per lesson: `- [YYYY-MM-DD] lesson — why it matters.`

- [2026-07-17] `~/.pixel-agents/*.json` state files are read by a possibly-running live server; every adapter method must read-merge-write a single field, never blind-overwrite the whole file, or a concurrent save from the running app gets clobbered.
