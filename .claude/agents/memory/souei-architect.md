# souei-architect — memory

Dated, append-only. One line per lesson: `- [YYYY-MM-DD] lesson — why it matters.`

- [2026-07-17] This agent was ported from a raw-API pipeline ("The Five Retainers") that had a real Anthropic API key hardcoded as the literal argument to `os.getenv(...)` instead of the env-var name — a design that never validates its own config at startup would have caught it. Treat any config-loading code in a design review as a place to check, not skip.
