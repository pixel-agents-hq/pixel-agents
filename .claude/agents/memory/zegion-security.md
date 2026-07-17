# zegion-security — memory

Dated, append-only. One line per lesson: `- [YYYY-MM-DD] lesson — why it matters.`

- [2026-07-17] Real finding in the source ecosystem this pipeline was ported from: a plaintext Anthropic API key was passed as the literal string argument to `os.getenv("Ask-ant-api03-...")` instead of `os.getenv("ANTHROPIC_API_KEY")` — functionally broken (always returns None) AND a live secret sitting in a `.py` file. Grep new/touched files for `os.getenv\(["']sk-` / `os.getenv\(["'](ask|Ask)-ant` style patterns, not just `.env` files.
