# Per-event provider resolution in the hook dispatch path

`HookEventHandler` used to normalize every wire event through its constructor
provider (Claude). With a second bundled provider (OpenCode), the event's own
`providerId` — already threaded through `handleHookEvent`, the session
router's buffer, and the HTTP route, but ignored — now resolves the provider
per event, falling back to the constructor provider for unknown ids.

Everything below is the rule for adding provider number three and beyond.

## What resolves per event, and what stays on the constructor provider

Per event (the resolved provider normalizes and displays the event in hand):

- `normalizeHookEvent` — the normalization boundary stays per provider.
- `formatToolStatus`, `subagentToolNames` — display and subagent routing.
- `team` — teammate branches self-guard on its presence, so a teamless
  provider takes the basic within-turn subagent path.

Stays on the constructor provider (Claude):

- File fallback (`getSessionDirs`, transcript parsing), terminal adoption
  (`terminalNamePrefix`), and every module-level singleton (`setHookProvider`,
  `setTeamProvider`). The OpenCode provider is hooks-only by construction:
  OpenCode persists sessions in SQLite (`~/.local/share/opencode/opencode.db`),
  not line-delimited transcripts, so there is no file fallback to implement.

## Why the subagent gates changed shape, and why Claude cannot tell

- `subagentStart` / `subagentEnd` used to require `provider.team` to reach
  their handlers. They now always route; the teammate branch inside still
  requires `provider.team`, and the basic path resolves the parent from JSONL
  first. The only new behavior is the hook fallback: a normalized parent id
  starting with `hook-` that equals the agent's live `currentHookToolId`.
  Claude normalizes the `'current'` sentinel there, which never equals a real
  id, so its routing is byte-for-byte identical.
- The `Task`/`Agent` overlay suppression is now `provider.subagentToolNames`
  instead of a name literal. Claude's set is exactly `{Task, Agent}`, so the
  suppression is identical; transcript-less providers suppress nothing because
  the hook display is their only display.
- Turn end additionally purges subagent map entries keyed `hook-*`. JSONL
  tool ids never carry that prefix, so JSONL-backed providers are unaffected.

## Rejected alternative

One `HookEventHandler` (and `AgentRuntime`) per provider: doubles every
timer map, scanner, and store subscription, and splits one office across two
state stores. The broadcast layer already multiplexes agents from any source;
per-event resolution keeps that property.
