# Department Board

Every floor has a **department board** — a live roster panel plus a manual
notes field, giving each floor ("Library", "Engineering", "CRM", whatever
you named it) a quick standup view without opening every agent's overlay
individually.

## What it looks like

```
┌────────────────────────┐
│  Engineering            │
│                         │
│  Staff (3)              │
│   ● Claudio  Running…   │
│   ○ web-researcher Idle │
│   ● Gitcat   Needs appr.│
│                         │
│  Help Wanted (1)        │
│   ● Gitcat   Needs appr.│
│                         │
│  Open Items (1)         │
│   ● Claudio  Running…   │
│                         │
│  Notes                  │
│  ┌───────────────────┐  │
│  │ Ship the login...  │  │
│  └───────────────────┘  │
└────────────────────────┘
```

Toggled with the **Board** button in the bottom toolbar, next to Layout and
Settings. Hidden by default; renders top-right, above the office canvas.

## The three lists

- **Staff** — every agent seated on the floor you're currently viewing
  (sub-agents excluded — they're transient Task helpers, not roster
  members).
- **Help Wanted** — the subset of staff currently blocked on a permission
  prompt.
- **Open Items** — the subset of staff currently running a tool.

These are not a partition — an agent that's both mid-tool and waiting on a
permission prompt appears in all three lists at once. Status text
("Running: npm test", "Needs approval", "Waiting for input", "Idle") comes
from the exact same logic the canvas overlay uses
(`getAgentActivityText` in `webview-ui/src/office/toolUtils.ts`), so the
board and the overlay never show conflicting descriptions of what an agent
is doing.

## Notes

A free-text field per floor — sprint focus, a link to today's standup doc,
whatever. Typing saves automatically (same debounced document save floor
edits use); there's no explicit Save button. Notes travel with the floor:
renaming, switching, or reloading doesn't touch them, and deleting a floor
removes its notes along with everything else on it.

## Persistence

Notes are stored as an optional `notes` field on each floor in the v2
document (`layout.json`):

```json
{
  "version": 2,
  "floors": [
    {
      "id": "floor-1",
      "name": "Engineering",
      "layout": { "...": "..." },
      "notes": "Ship the login page today."
    }
  ]
}
```

Omitted entirely when empty, so a floor with no notes doesn't bloat the
persisted document. Old exports without a `notes` field still import
cleanly — it's optional on read (`migrateToDocument` in
`webview-ui/src/office/layout/layoutSerializer.ts`).

## Testing

`e2e/tests/claude/hooks-off/lifecycle.spec.ts` › _"department board: live
roster, notes persist, scoped to viewed floor"_ spawns an agent running a
tool, confirms it shows up in both Staff and Open Items (not Help Wanted,
since nothing needs approval yet) with matching status text, types a note,
and confirms it lands in `layout.json` on disk.

The pure roster derivation (`webview-ui/src/office/departmentBoard.ts`) has
its own unit test suite (`webview-ui/test/departmentBoard.test.ts`, 9
cases) covering floor scoping, subagent exclusion, list membership, and the
label fallback chain (`name` → `agentName` → `"Agent <id>"`) — this project
relies on Playwright e2e for UI behavior, but a pure data-derivation
function with no rendering is exactly the kind of deterministic logic unit
tests are for (same precedent as `layoutSerializer.test.ts` and
`petEntity.test.ts`).
