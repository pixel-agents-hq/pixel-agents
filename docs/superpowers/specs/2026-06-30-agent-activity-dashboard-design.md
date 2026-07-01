# Agent Activity Dashboard — Design

**Date:** 2026-06-30
**Status:** Implemented
**Surface:** Standalone CLI (`npx pixel-agents`, browser) only for v1

## Goal

Turn Pixel Agents into a live dashboard for the user's own Claude Code activity.
The pixel characters already represent concurrent Claude Code sessions; this feature
adds the missing pieces:

1. Each character shows **which project** it belongs to (a label under its feet).
2. Clicking a character opens a **detail panel** with that agent's status, progress,
   and a live activity log.
3. The screen is a **vertical split**: the office canvas stays pinned to a resizable
   top region; the detail panel lives below it — inspection happens in the panel, not
   by zooming the canvas.

## Scope

**In scope (v1):**

- Resizable top-canvas / bottom-panel split layout (standalone only).
- Per-character project label (uses existing `folderName`; no protocol change).
- Detail panel with a **status header** (project, status, token usage, sub-agents)
  and a **live activity feed** (timestamped tool/status/turn events).
- Overview state in the panel when no agent is selected (list of active agents).
- Server-side activity ring buffer + protocol to deliver backlog and live appends.

**Out of scope (v1):**

- Full JSONL transcript rendering (assistant text / thinking / raw tool results).
  The feed is the live _event_ history, not the raw conversation.
- VS Code surface. The new layout is gated behind the browser runtime so VS Code
  behavior and its e2e suite are unchanged. Components are written surface-agnostic
  so VS Code can be enabled later by flipping one gate.

## Decisions (from brainstorming)

| Question      | Decision                                                            |
| ------------- | ------------------------------------------------------------------- |
| Panel content | Live activity feed + status header (no file parsing in v1)          |
| Layout        | Resizable vertical split, always-on, overview when nothing selected |
| Surface       | Standalone (browser) only                                           |
| Project label | Under each character **and** in the panel header                    |

## Architecture

Layering is preserved: `core/` (protocol) → `server/` (runtime) → `webview-ui/`
(UI). The standalone CLI never imports `adapters/vscode/`.

### Data flow (new)

```
existing AgentEvent dispatch (toolStart / turnEnd / permission / status / session / subagent)
        │
        ├─ (existing) store mutation → existing ServerMessage broadcast   [unchanged]
        │
        └─ (new) store.appendActivity(id, entry)
                   │
                   ├─ ring buffer in AgentState.activityLog (capped)
                   └─ store event → broadcast layer → `agentActivity` (live, one entry)

client selects an agent
        │
        └─ ClientMessage `requestActivity { id }`
                   │
                   └─ server replies `agentActivityHistory { id, projectDir, entries[] }`
```

### Protocol additions (`core/asyncapi.yaml`)

`ActivityEntry` (shared schema):

```
{
  ts: number;        // epoch ms, server clock
  kind: 'tool' | 'subagent' | 'turnEnd' | 'permission' | 'status' | 'session';
  label: string;     // human text, reuses provider.formatToolStatus where applicable
  toolName?: string; // raw tool name (icon / animation mapping)
  detail?: string;   // optional secondary text (file path / short arg summary)
}
```

New messages:

- **ServerMessage `agentActivity`** — `{ type, id, entry: ActivityEntry }`. One live
  append, broadcast whenever `appendActivity` runs.
- **ServerMessage `agentActivityHistory`** — `{ type, id, projectDir?, entries: ActivityEntry[] }`.
  Backlog reply; sent on `requestActivity`.
- **ClientMessage `requestActivity`** — `{ type, id }`. Mirrors the existing
  `requestDiagnostics` → `agentDiagnostics` request/response pattern.

All concrete messages keep `additionalProperties: false` and `discriminator: type`.
After editing the YAML, `npm run asyncapi:generate` regenerates `core/src/messages.ts`
(CI drift check guards this). Counts move 26 → 28 ServerMessage, 18 → 19 ClientMessage.

### Server changes

- **`server/src/types.ts`** — add `activityLog: ActivityEntry[]` to `AgentState`.
- **`server/src/agentStateStore.ts`** — add `appendActivity(id, entry)` mutation that
  pushes to the bounded buffer (drops oldest past `ACTIVITY_LOG_MAX`) and emits a typed
  `activityAppended` event; add a `getActivity(id)` snapshot getter.
- **Broadcast layer** — translate `activityAppended` → `agentActivity` ServerMessage.
- **Dispatch points** — at the existing places that already produce tool/status/turn/
  permission/session broadcasts (in the runtime / `hookEventHandler`), also call
  `store.appendActivity` with a normalized entry. No new event sources; this is a tee
  off the events already flowing.
- **`server/src/clientMessageHandler.ts`** — handle `requestActivity`: read
  `getActivity(id)` + the agent's `projectDir`, reply `agentActivityHistory`.
- **`server/src/constants.ts`** — `ACTIVITY_LOG_MAX` (e.g. 50).

### Client changes (`webview-ui/`)

- **Selection lifted to React.** `OfficeCanvas` gains an `onAgentSelectionChange(id | null)`
  callback fired on _every_ selection change — click, ToolOverlay close button, and
  Esc-deselect — mirroring the existing `onEditorSelectionChange` furniture pattern.
  `App.tsx` holds `selectedAgentId` in React state and sends `requestActivity` on select.
- **`webview-ui/src/hooks/useExtensionMessages.ts`** — handle `agentActivity` (append)
  and `agentActivityHistory` (replace) into a bounded `Map<agentId, ActivityEntry[]>`
  (capped per agent to match the server).
- **Layout (`App.tsx`).** When `isBrowserRuntime`, root is `flex flex-col`:
  - Canvas region wrapper (`position: relative`, `flex-grow`) containing `OfficeCanvas`
    together with its overlays (`ZoomControls`, `ToolOverlay`, editor UI, `ProjectLabels`).
    Moving the overlays inside this wrapper keeps their world→screen coordinates correct
    after the canvas shrinks (today they assume full viewport).
  - A drag divider; height persisted in `localStorage`, with a min height and a
    collapse toggle to reclaim the full canvas.
  - `AgentDetailPanel` below.

  In VS Code (`!isBrowserRuntime`) the current full-canvas layout is unchanged.

- **New components:**
  - `AgentDetailPanel.tsx` — overview list when nothing is selected (each row: project,
    status, last action; click selects + camera-follows); status header + live feed when
    selected. Feed is newest-first, auto-scrolls, relative timestamps with absolute
    tooltip.
  - `ProjectLabels.tsx` — dim per-character `folderName` label under each character's
    feet, reusing ToolOverlay's world→screen transform.
  - Resizable divider (small component or inline in `App.tsx`).

All new UI obeys the pixel-art ESLint rules (`no-inline-colors`, `pixel-shadow`,
`pixel-font`) — colors only via CSS vars / `constants.ts`, FS Pixel Sans font.

## Error handling

- `requestActivity` for an unknown/removed agent → server replies with empty `entries`
  (no throw), consistent with existing graceful-degradation style.
- Client tolerates `agentActivity` for an agent not yet in its map (creates the entry).
- Activity buffers are bounded on both ends; no unbounded growth.

## Testing

- **Server unit (Vitest):**
  - `agentStateStore.test.ts` — `appendActivity` push, cap/drop-oldest, `activityAppended` event, `getActivity`.
  - `clientMessageHandler` / `server.test.ts` — `requestActivity` → `agentActivityHistory` round-trip incl. `projectDir`.
  - `hookEventHandler.test.ts` — an incoming event tees an activity entry of the right `kind`/`label`.
- **Standalone e2e (Playwright, follows `e2e/README.md` rules):**
  - Select an agent → detail panel shows the status header and ≥1 activity entry after a
    mock tool runs.
  - Drag divider resizes the panel.
  - Project label renders under a character.
    Asserts on visible outcomes only; drives state through the mock-claude scenario runner.

## Rollout / housekeeping

- Update CLAUDE.md message counts and the ServerMessage/ClientMessage tables.
- `npm run compile` (asyncapi generate + types + lint + build) and `npm test` must pass;
  e2e for the standalone area.
