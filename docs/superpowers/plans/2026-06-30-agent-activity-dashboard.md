# Agent Activity Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone-only split layout where the office canvas is pinned to a resizable top region and a bottom panel shows a clicked agent's live activity feed + status, plus a per-character project label.

**Architecture:** The server tees a normalized `ActivityEntry` off the events it already dispatches into a per-agent ring buffer, broadcasting each as a live `agentActivity` message and replying to `requestActivity` with an `agentActivityHistory` backlog. The webview keeps a `Record<agentId, ActivityEntry[]>`, lifts canvas selection into React, and (only when `isBrowserRuntime`) renders a resizable bottom `AgentDetailPanel` plus a `ProjectLabels` overlay under each character. The VS Code surface is untouched.

**Tech Stack:** TypeScript (Node16 ESM for core/server, Vite/React 19 for webview), AsyncAPI 3.0 + Modelina codegen, Fastify WS, Vitest, Playwright.

## Global Constraints

- **Protocol is generated:** never hand-edit `core/src/messages.ts`. Edit `core/asyncapi.yaml`, then run `npm run asyncapi:generate`. CI runs `git diff --exit-code core/src/messages.ts` — any drift fails.
- **No `enum`** anywhere (webview `erasableSyntaxOnly`); use `as const` if needed. New `ActivityEntry.kind` is typed `string` (not an enum) for predictable codegen.
- **`import type`** for type-only imports; **`.js` extension** on every relative import in `core/`, `server/`, and `webview-ui/`.
- **`noUnusedLocals` / `noUnusedParameters`** strict everywhere.
- **No inline colors** (hex/rgb/rgba/hsl) outside `webview-ui/src/constants.ts` — ESLint `error`. In components use `var(--pixel-*)`/`var(--color-*)` CSS tokens or imported constants. Shadows use `var(--pixel-shadow)` or `2px 2px 0px`. Pixel font: FS Pixel Sans.
- **Standalone-only UI:** all new layout/panel/label UI renders only when `isBrowserRuntime` (from `webview-ui/src/runtime.js`). The `!isBrowserRuntime` (VS Code) branch must render exactly today's structure.
- **Message counts (correct current values):** ServerMessage oneOf = **27** (CLAUDE.md's "26" is stale — `PetSpritesLoaded` exists), ClientMessage oneOf = **18**. After this work: **29** ServerMessage, **19** ClientMessage.
- **Commits:** the pre-commit hook runs gitleaks + prettier + eslint on staged files. Commit after each task. Branch is `feat/agent-activity-dashboard`.
- **Relative import paths to core:** from `server/src/*.ts` use `../../core/src/<f>.js`; from `webview-ui/src/hooks|components/*` use `../../../core/src/<f>.js`; from `webview-ui/src/office/components/*` use `../../../../core/src/<f>.js`. Verify with a quick `grep` of an existing import in the same dir if the typecheck complains.

---

### Task 1: Protocol — ActivityEntry + 3 messages in AsyncAPI, regenerate bindings

**Files:**

- Modify: `core/asyncapi.yaml` (ServerMessage oneOf ~line 114; ClientMessage oneOf ~line 137; server-message-variants section ~line 645 near `AgentDiagnostics`; client-message-variants ~line 837 near `RequestDiagnostics`; supporting-schemas section ~line 878 near `WorkspaceFolder`)
- Generated (do not hand-edit): `core/src/messages.ts`

**Interfaces:**

- Produces (generated TS consumed by every later task):
  - `interface ActivityEntry { ts: number; kind: string; label: string; toolName?: string; detail?: string }`
  - `interface AgentActivity { type: 'agentActivity'; id: number; entry: ActivityEntry }`
  - `interface AgentActivityHistory { type: 'agentActivityHistory'; id: number; projectDir?: string; entries: ActivityEntry[] }`
  - `interface RequestActivity { type: 'requestActivity'; id: number }`

- [ ] **Step 1: Add the `ActivityEntry` supporting schema.** In `core/asyncapi.yaml`, in the "Supporting schemas" section (next to `WorkspaceFolder`), add:

```yaml
ActivityEntry:
  description: One entry in an agent's activity feed (a tool call, turn end, etc.).
  type: object
  additionalProperties: false
  required: [ts, kind, label]
  properties:
    ts:
      type: integer
      description: Server clock timestamp (epoch ms) when the event was recorded.
    kind:
      type: string
      description: Category hint for styling — one of tool, subagent, turnEnd, permission, session.
    label:
      type: string
      description: Human-readable line to display.
    toolName:
      type: string
    detail:
      type: string
```

- [ ] **Step 2: Add the two ServerMessage variant schemas.** In the "Server message variants" section (next to `AgentDiagnostics`), add:

```yaml
AgentActivity:
  description: One live activity entry appended for an agent.
  type: object
  additionalProperties: false
  required: [type, id, entry]
  properties:
    type:
      const: agentActivity
    id:
      type: integer
    entry:
      $ref: '#/components/schemas/ActivityEntry'

AgentActivityHistory:
  description: Recent activity backlog for one agent (response to requestActivity).
  type: object
  additionalProperties: false
  required: [type, id, entries]
  properties:
    type:
      const: agentActivityHistory
    id:
      type: integer
    projectDir:
      type: string
    entries:
      type: array
      items:
        $ref: '#/components/schemas/ActivityEntry'
```

- [ ] **Step 3: Add the ClientMessage variant schema.** In the "Client message variants" section (next to `RequestDiagnostics`), add:

```yaml
RequestActivity:
  description: Request recent activity backlog for one agent (server responds with agentActivityHistory).
  type: object
  additionalProperties: false
  required: [type, id]
  properties:
    type:
      const: requestActivity
    id:
      type: integer
```

- [ ] **Step 4: Register all three in the oneOf unions.** In `ServerMessage.oneOf`, immediately after the `- $ref: '#/components/schemas/AgentDiagnostics'` line (still before `discriminator: type`), add:

```yaml
# Activity feed
- $ref: '#/components/schemas/AgentActivity'
- $ref: '#/components/schemas/AgentActivityHistory'
```

In `ClientMessage.oneOf`, immediately after the `- $ref: '#/components/schemas/RequestDiagnostics'` line, add:

```yaml
- $ref: '#/components/schemas/RequestActivity'
```

- [ ] **Step 5: Validate + regenerate.**

Run: `npm run asyncapi:validate && npm run asyncapi:generate`
Expected: validate passes; generate rewrites `core/src/messages.ts` with no errors.

- [ ] **Step 6: Verify the generated types exist and the banner is intact.**

Run: `grep -nE "interface (ActivityEntry|AgentActivity|AgentActivityHistory|RequestActivity)|AUTO-GENERATED" core/src/messages.ts`
Expected: one match for the AUTO-GENERATED banner and one `interface` line for each of the four names. Also confirm `ActivityEntry` has `kind: string;` and `AgentActivityHistory` has `entries: ActivityEntry[];`.

- [ ] **Step 7: Commit.**

```bash
git add core/asyncapi.yaml core/src/messages.ts
git commit -m "feat(protocol): add agentActivity, agentActivityHistory, requestActivity messages"
```

---

### Task 2: Server — `buildActivityEntry` pure mapper (TDD)

**Files:**

- Create: `server/src/activityLog.ts`
- Test: `server/__tests__/activityLog.test.ts`

**Interfaces:**

- Consumes: `ActivityEntry` (Task 1); `AgentEvent`, `HookProvider` from `core/src/provider.js`.
- Produces: `export function buildActivityEntry(event: AgentEvent, provider: HookProvider, now: number): ActivityEntry | null` — used by Task 4.

- [ ] **Step 1: Write the failing test.** Create `server/__tests__/activityLog.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { buildActivityEntry } from '../src/activityLog.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';

describe('buildActivityEntry', () => {
  it('maps toolStart to a tool entry with the formatted label', () => {
    const entry = buildActivityEntry(
      { kind: 'toolStart', toolId: 't1', toolName: 'Read', input: { file_path: '/x/foo.ts' } },
      claudeProvider,
      1000,
    );
    expect(entry).toEqual({ ts: 1000, kind: 'tool', label: 'Reading foo.ts', toolName: 'Read' });
  });

  it('maps subagentStart to a subagent entry', () => {
    const entry = buildActivityEntry(
      { kind: 'subagentStart', parentToolId: 'current', toolId: 's1', toolName: 'reviewer' },
      claudeProvider,
      2000,
    );
    expect(entry).toMatchObject({
      kind: 'subagent',
      label: 'Subtask: reviewer',
      toolName: 'reviewer',
    });
  });

  it('distinguishes turnEnd waiting vs done by awaitingInput', () => {
    expect(
      buildActivityEntry({ kind: 'turnEnd', awaitingInput: true }, claudeProvider, 3000),
    ).toMatchObject({ kind: 'turnEnd', label: 'Waiting for input' });
    expect(buildActivityEntry({ kind: 'turnEnd' }, claudeProvider, 3000)).toMatchObject({
      kind: 'turnEnd',
      label: 'Turn ended',
    });
  });

  it('maps permissionRequest, sessionStart, sessionEnd', () => {
    expect(buildActivityEntry({ kind: 'permissionRequest' }, claudeProvider, 4000)).toMatchObject({
      kind: 'permission',
      label: 'Needs approval',
    });
    expect(buildActivityEntry({ kind: 'sessionStart' }, claudeProvider, 5000)).toMatchObject({
      kind: 'session',
      label: 'Session started',
    });
    expect(
      buildActivityEntry({ kind: 'sessionEnd', reason: 'clear' }, claudeProvider, 6000),
    ).toMatchObject({ kind: 'session', label: 'Session ended (clear)' });
  });

  it('returns null for non-feed kinds (toolEnd)', () => {
    expect(
      buildActivityEntry({ kind: 'toolEnd', toolId: 'current' }, claudeProvider, 7000),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm run test:server -- activityLog`
Expected: FAIL — `Cannot find module '../src/activityLog.js'`.

- [ ] **Step 3: Implement `server/src/activityLog.ts`.**

```typescript
import type { ActivityEntry } from '../../core/src/messages.js';
import type { AgentEvent, HookProvider } from '../../core/src/provider.js';

/**
 * Map a normalized AgentEvent to a feed entry, or null for kinds we don't surface
 * (toolEnd, subagentEnd, subagentTurnEnd, progress). Pure — `now` is injected so it
 * is trivially testable.
 */
export function buildActivityEntry(
  event: AgentEvent,
  provider: HookProvider,
  now: number,
): ActivityEntry | null {
  switch (event.kind) {
    case 'toolStart':
      return {
        ts: now,
        kind: 'tool',
        label: provider.formatToolStatus(event.toolName, event.input),
        toolName: event.toolName,
      };
    case 'subagentStart':
      return {
        ts: now,
        kind: 'subagent',
        label: `Subtask: ${event.toolName}`,
        toolName: event.toolName,
      };
    case 'turnEnd':
      return {
        ts: now,
        kind: 'turnEnd',
        label: event.awaitingInput ? 'Waiting for input' : 'Turn ended',
      };
    case 'permissionRequest':
      return { ts: now, kind: 'permission', label: 'Needs approval' };
    case 'sessionStart':
      return { ts: now, kind: 'session', label: 'Session started' };
    case 'sessionEnd':
      return {
        ts: now,
        kind: 'session',
        label: event.reason ? `Session ended (${event.reason})` : 'Session ended',
      };
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npm run test:server -- activityLog`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit.**

```bash
git add server/src/activityLog.ts server/__tests__/activityLog.test.ts
git commit -m "feat(server): add buildActivityEntry feed mapper"
```

---

### Task 3: Server — `AgentState.activityLog` + `appendActivity`/`getActivity` on the store (TDD)

**Files:**

- Modify: `server/src/constants.ts` (add `ACTIVITY_LOG_MAX`)
- Modify: `server/src/types.ts` (add optional `activityLog` field + import `ActivityEntry`)
- Modify: `server/src/agentStateStore.ts` (add `appendActivity`, `getActivity`, imports)
- Test: `server/__tests__/agentStateStore.test.ts` (append to existing file)

**Interfaces:**

- Consumes: `ActivityEntry` (Task 1).
- Produces: `appendActivity(id: number, entry: ActivityEntry): void` (records to ring buffer + broadcasts `{type:'agentActivity', id, entry}`) and `getActivity(id: number): ActivityEntry[]` — used by Tasks 4 and 5.

- [ ] **Step 1: Write the failing tests.** Append to `server/__tests__/agentStateStore.test.ts` (inside the top-level `describe('AgentStateStore', ...)`), reusing its existing `createTestAgent` helper:

```typescript
describe('activity log', () => {
  const entry = { ts: 1, kind: 'tool', label: 'Reading foo.ts', toolName: 'Read' };

  it('appendActivity records the entry and broadcasts agentActivity', () => {
    const cb = vi.fn();
    store.on('broadcast', cb);
    store.set(1, createTestAgent({ id: 1 }));
    store.appendActivity(1, entry);
    expect(store.getActivity(1)).toEqual([entry]);
    expect(cb).toHaveBeenCalledWith({ type: 'agentActivity', id: 1, entry });
  });

  it('appendActivity caps the buffer at ACTIVITY_LOG_MAX (drops oldest)', () => {
    store.set(1, createTestAgent({ id: 1 }));
    for (let i = 0; i < 60; i++) store.appendActivity(1, { ts: i, kind: 'tool', label: `e${i}` });
    const log = store.getActivity(1);
    expect(log.length).toBe(50);
    expect(log[0].label).toBe('e10'); // first 10 dropped
    expect(log[log.length - 1].label).toBe('e59');
  });

  it('appendActivity is a no-op for an unknown agent; getActivity returns []', () => {
    const cb = vi.fn();
    store.on('broadcast', cb);
    store.appendActivity(999, entry);
    expect(cb).not.toHaveBeenCalled();
    expect(store.getActivity(999)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npm run test:server -- agentStateStore`
Expected: FAIL — `store.appendActivity is not a function` / `getActivity is not a function`.

- [ ] **Step 3: Add the constant.** In `server/src/constants.ts` add (under an appropriate section):

```typescript
/** Max activity-feed entries retained per agent (ring buffer, server + client). */
export const ACTIVITY_LOG_MAX = 50;
```

- [ ] **Step 4: Add the field to `AgentState`.** In `server/src/types.ts`, add the import at the top (matching the existing core-import style in this file) and the optional field inside `interface AgentState`:

```typescript
import type { ActivityEntry } from '../../core/src/messages.js';
```

```typescript
  /** Recent activity-feed entries (capped at ACTIVITY_LOG_MAX). Lazily initialized. */
  activityLog?: ActivityEntry[];
```

- [ ] **Step 5: Add the store methods.** In `server/src/agentStateStore.ts`, add imports:

```typescript
import type { ActivityEntry } from '../../core/src/messages.js';
import { ACTIVITY_LOG_MAX } from './constants.js';
```

Then add these methods to the `AgentStateStore` class (next to `broadcast`):

```typescript
  /** Append a feed entry to an agent's ring buffer and broadcast it live. */
  appendActivity(id: number, entry: ActivityEntry): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    const log = (agent.activityLog ??= []);
    log.push(entry);
    if (log.length > ACTIVITY_LOG_MAX) {
      log.splice(0, log.length - ACTIVITY_LOG_MAX);
    }
    this.broadcast({ type: 'agentActivity', id, entry });
  }

  /** Snapshot of an agent's recent activity (empty if unknown). */
  getActivity(id: number): ActivityEntry[] {
    return this.agents.get(id)?.activityLog ?? [];
  }
```

- [ ] **Step 6: Run to verify pass.**

Run: `npm run test:server -- agentStateStore`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 7: Commit.**

```bash
git add server/src/constants.ts server/src/types.ts server/src/agentStateStore.ts server/__tests__/agentStateStore.test.ts
git commit -m "feat(server): add per-agent activity ring buffer to AgentStateStore"
```

---

### Task 4: Server — tee `appendActivity` into the hook dispatch (TDD)

**Files:**

- Modify: `server/src/hookEventHandler.ts` (insert tee after the `agent.hookDelivered = true;` choke point ~line 316, and in the sessionStart known-agent branch ~line 180)
- Test: `server/__tests__/hookEventHandler.test.ts` (append a test)

**Interfaces:**

- Consumes: `buildActivityEntry` (Task 2), `store.appendActivity` (Task 3).

- [ ] **Step 1: Write the failing test.** Append inside `describe('HookEventHandler', ...)` in `server/__tests__/hookEventHandler.test.ts`:

```typescript
it('records an activity entry on a tool start', () => {
  agents.set(1, createTestAgent({ id: 1 }));
  handler.registerAgent('sess-1', 1);

  handler.handleEvent('claude', {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-1',
    tool_name: 'Read',
    tool_input: { file_path: '/x/foo.ts' },
  });

  const log = agents.getActivity(1);
  expect(log.at(-1)).toMatchObject({ kind: 'tool', toolName: 'Read', label: 'Reading foo.ts' });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npm run test:server -- hookEventHandler`
Expected: FAIL — `log.at(-1)` is undefined (no tee yet).

- [ ] **Step 3: Add the import.** At the top of `server/src/hookEventHandler.ts`:

```typescript
import { buildActivityEntry } from './activityLog.js';
```

- [ ] **Step 4: Insert the primary tee.** Find the line `agent.hookDelivered = true;` that immediately precedes the `switch (normEvent.kind)` block (~line 316). Directly after it insert:

```typescript
// Tee a feed entry off the same normalized event that drives broadcasts.
const activityEntry = buildActivityEntry(normEvent, this.provider, Date.now());
if (activityEntry) this.agents.appendActivity(agentId, activityEntry);
```

- [ ] **Step 5: Insert the sessionStart tee.** `sessionStart` returns before the switch. In the known-agent branch (~line 178-188) where `const agent = this.agents.get(existingAgentId);` is fetched and `agent.hookDelivered = true;` is set, add inside that `if (agent) { ... }` block, after `agent.hookDelivered = true;`:

```typescript
const startEntry = buildActivityEntry(normEvent, this.provider, Date.now());
if (startEntry) this.agents.appendActivity(existingAgentId, startEntry);
```

- [ ] **Step 6: Run to verify pass + no regression.**

Run: `npm run test:server -- hookEventHandler`
Expected: PASS (all existing tests + the new one).

- [ ] **Step 7: Commit.**

```bash
git add server/src/hookEventHandler.ts server/__tests__/hookEventHandler.test.ts
git commit -m "feat(server): record activity entries from hook event dispatch"
```

---

### Task 5: Server — handle `requestActivity` in the standalone client handler (TDD)

**Files:**

- Modify: `server/src/clientMessageHandler.ts` (add a `case 'requestActivity'`)
- Test: `server/__tests__/clientMessageHandler.test.ts` (new file)

**Interfaces:**

- Consumes: `store.getActivity` + `store.get(id)?.projectDir` (Task 3); `ClientMessageContext` (`{ store; runtime?; cache; onSetHooksEnabled? }`).
- Produces: a `send({ type: 'agentActivityHistory', id, projectDir, entries })` reply.

- [ ] **Step 1: Write the failing test.** Create `server/__tests__/clientMessageHandler.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import type { AgentState } from '../src/types.js';

describe('handleClientMessage: requestActivity', () => {
  it('replies with agentActivityHistory including projectDir and entries', () => {
    const store = new AgentStateStore();
    const entry = { ts: 1, kind: 'tool', label: 'Reading foo.ts', toolName: 'Read' };
    store.set(1, { id: 1, projectDir: '/my/proj', activityLog: [entry] } as unknown as AgentState);

    const sent: Array<Record<string, unknown>> = [];
    handleClientMessage({ type: 'requestActivity', id: 1 }, (m) => sent.push(m), {
      store,
      cache: null,
    });

    expect(sent).toContainEqual({
      type: 'agentActivityHistory',
      id: 1,
      projectDir: '/my/proj',
      entries: [entry],
    });
  });

  it('replies with empty entries for an unknown agent', () => {
    const store = new AgentStateStore();
    const sent: Array<Record<string, unknown>> = [];
    handleClientMessage({ type: 'requestActivity', id: 42 }, (m) => sent.push(m), {
      store,
      cache: null,
    });
    expect(sent).toContainEqual({
      type: 'agentActivityHistory',
      id: 42,
      projectDir: undefined,
      entries: [],
    });
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npm run test:server -- clientMessageHandler`
Expected: FAIL — no `agentActivityHistory` reply (falls into the no-op `default`).

- [ ] **Step 3: Add the case.** In `server/src/clientMessageHandler.ts`, inside the `switch (msg.type)`, before the `default:` branch add:

```typescript
    case 'requestActivity': {
      const id = msg.id as number;
      send({
        type: 'agentActivityHistory',
        id,
        projectDir: store.get(id)?.projectDir,
        entries: store.getActivity(id),
      });
      break;
    }
```

- [ ] **Step 4: Run to verify pass.**

Run: `npm run test:server -- clientMessageHandler`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit.**

```bash
git add server/src/clientMessageHandler.ts server/__tests__/clientMessageHandler.test.ts
git commit -m "feat(server): handle requestActivity with agentActivityHistory reply"
```

---

### Task 6: Client — consume `agentActivity` / `agentActivityHistory` in useExtensionMessages

**Files:**

- Modify: `webview-ui/src/hooks/useExtensionMessages.ts`
- Modify: `webview-ui/src/constants.ts` (add `ACTIVITY_LOG_CLIENT_MAX`)

**Interfaces:**

- Consumes: `ActivityEntry` from `../../../core/src/messages.js`.
- Produces: hook now returns `agentActivity: Record<number, ActivityEntry[]>` — consumed by Task 8.

Note: per the repo's "E2E over webview unit tests" policy, webview behavior is verified by the Task 9 e2e plus typecheck/lint — no Vitest is added here.

- [ ] **Step 1: Add the client cap constant.** In `webview-ui/src/constants.ts` (Rendering or a new `// ── Agent Detail Panel ──` banner):

```typescript
// ── Agent Detail Panel ──────────────────────────────────────
/** Max activity entries kept per agent client-side (mirror server ACTIVITY_LOG_MAX). */
export const ACTIVITY_LOG_CLIENT_MAX = 50;
```

- [ ] **Step 2: Import the type and the constant.** At the top of `webview-ui/src/hooks/useExtensionMessages.ts` add:

```typescript
import type { ActivityEntry } from '../../../core/src/messages.js';
import { ACTIVITY_LOG_CLIENT_MAX } from '../constants.js';
```

- [ ] **Step 3: Add the React state map.** Next to the other per-agent `useState` declarations (~line 91-98):

```typescript
const [agentActivity, setAgentActivity] = useState<Record<number, ActivityEntry[]>>({});
```

- [ ] **Step 4: Handle the two messages.** Inside the `handler` if/else-if chain (e.g. after the `agentTokenUsage` branch), add:

```typescript
      } else if (msg.type === 'agentActivity') {
        const id = msg.id as number;
        const entry = msg.entry as ActivityEntry;
        setAgentActivity((prev) => {
          const list = prev[id] ?? [];
          const next = [...list, entry];
          if (next.length > ACTIVITY_LOG_CLIENT_MAX) next.splice(0, next.length - ACTIVITY_LOG_CLIENT_MAX);
          return { ...prev, [id]: next };
        });
      } else if (msg.type === 'agentActivityHistory') {
        const id = msg.id as number;
        const entries = msg.entries as ActivityEntry[];
        setAgentActivity((prev) => ({ ...prev, [id]: entries }));
```

- [ ] **Step 5: Return it from the hook.** Add `agentActivity,` to the hook's returned object (~line 582-603).

- [ ] **Step 6: Verify types + lint.**

Run: `npm run check-types && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit.**

```bash
git add webview-ui/src/hooks/useExtensionMessages.ts webview-ui/src/constants.ts
git commit -m "feat(webview): track per-agent activity feed from server messages"
```

---

### Task 7: Client — lift canvas selection into React + request activity on select

**Files:**

- Modify: `webview-ui/src/office/components/OfficeCanvas.tsx` (add `onAgentSelectionChange` prop; fire it at every `selectedAgentId` mutation; add to `handleClick` deps)
- Modify: `webview-ui/src/App.tsx` (hold `selectedAgentId` state; create handler; pass prop)

**Interfaces:**

- Produces: `OfficeCanvas` prop `onAgentSelectionChange: (id: number | null) => void`; App state `selectedAgentId: number | null` — consumed by Task 8.

Verified by Task 9 e2e + typecheck/lint (no Vitest per repo policy).

- [ ] **Step 1: Add the prop to the interface.** In `OfficeCanvasProps` (`webview-ui/src/office/components/OfficeCanvas.tsx` ~line 28-43) add:

```typescript
  onAgentSelectionChange: (id: number | null) => void;
```

- [ ] **Step 2: Destructure it** in the component params list (next to `onClick`, `onEditorSelectionChange`).

- [ ] **Step 3: Fire it in `handleClick`.** In the hit branch (~line 676-683), after the toggle that sets `officeState.selectedAgentId`, call the callback with the new value, then keep the existing `onClick(hitId)`:

```typescript
if (officeState.selectedAgentId === hitId) {
  officeState.selectedAgentId = null;
  officeState.cameraFollowId = null;
} else {
  officeState.selectedAgentId = hitId;
  officeState.cameraFollowId = hitId;
}
onAgentSelectionChange(officeState.selectedAgentId);
onClick(hitId); // still focus terminal
return;
```

- [ ] **Step 4: Fire it at every deselect site.** In the seat-click and empty-space branches (~line 705-744), after each pair that sets `officeState.selectedAgentId = null; officeState.cameraFollowId = null;`, add:

```typescript
onAgentSelectionChange(null);
```

(There are three such null-assignment sites in that block — own-seat send-back, reassign, and the final empty-space deselect. Add the call after each.)

- [ ] **Step 5: Add `onAgentSelectionChange` to the `handleClick` `useCallback` dependency array** (~line 746).

- [ ] **Step 6: App state + handler.** In `webview-ui/src/App.tsx`, add inside `App()`:

```typescript
const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);
const handleAgentSelectionChange = useCallback((id: number | null) => {
  setSelectedAgentId(id);
  if (id !== null && id > 0) transport.send({ type: 'requestActivity', id });
}, []);
```

- [ ] **Step 7: Pass the prop** to `<OfficeCanvas ... />` (~line 183-198):

```typescript
onAgentSelectionChange = { handleAgentSelectionChange };
```

- [ ] **Step 8: Verify types + lint.**

Run: `npm run check-types && npm run lint`
Expected: no errors.

- [ ] **Step 9: Commit.**

```bash
git add webview-ui/src/office/components/OfficeCanvas.tsx webview-ui/src/App.tsx
git commit -m "feat(webview): lift agent selection into React and request activity on select"
```

---

### Task 8: Client — AgentDetailPanel, ProjectLabels, resizable split layout

**Files:**

- Create: `webview-ui/src/components/AgentDetailPanel.tsx`
- Create: `webview-ui/src/components/ResizablePanelDivider.tsx`
- Create: `webview-ui/src/office/components/ProjectLabels.tsx`
- Modify: `webview-ui/src/constants.ts` (panel/label constants)
- Modify: `webview-ui/src/App.tsx` (split layout gated by `isBrowserRuntime`; render panel/divider/labels)

**Interfaces:**

- Consumes: `agentActivity`, `agentStatuses`, `agents` (from the hook), `officeState`, `selectedAgentId` + `handleAgentSelectionChange` (Task 7), `isBrowserRuntime`.

Verified by Task 9 e2e + typecheck/lint.

- [ ] **Step 1: Add layout constants.** In `webview-ui/src/constants.ts` under the `// ── Agent Detail Panel ──` banner:

```typescript
export const DETAIL_PANEL_DEFAULT_HEIGHT = 240;
export const DETAIL_PANEL_MIN_HEIGHT = 120;
export const DETAIL_PANEL_MAX_HEIGHT_RATIO = 0.6;
export const DETAIL_PANEL_HEIGHT_STORAGE_KEY = 'pixel-agents.detailPanelHeight';
/** Vertical offset (world px) below a character's feet for its project label. */
export const PROJECT_LABEL_BELOW_OFFSET_PX = 10;
```

- [ ] **Step 2: Create `ResizablePanelDivider.tsx`.**

```tsx
import { useCallback } from 'react';

import { DETAIL_PANEL_MAX_HEIGHT_RATIO, DETAIL_PANEL_MIN_HEIGHT } from '../constants.js';

interface Props {
  height: number;
  onHeightChange: (h: number) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function ResizablePanelDivider({
  height,
  onHeightChange,
  collapsed,
  onToggleCollapse,
}: Props) {
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = height;
      const max = window.innerHeight * DETAIL_PANEL_MAX_HEIGHT_RATIO;
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(
          max,
          Math.max(DETAIL_PANEL_MIN_HEIGHT, startH + (startY - ev.clientY)),
        );
        onHeightChange(next);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [height, onHeightChange],
  );

  return (
    <div
      data-testid="detail-panel-divider"
      onMouseDown={collapsed ? undefined : onMouseDown}
      style={{
        height: 8,
        cursor: collapsed ? 'default' : 'ns-resize',
        background: 'var(--pixel-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        flexShrink: 0,
      }}
    >
      <button
        data-testid="detail-panel-collapse"
        onClick={onToggleCollapse}
        style={{
          font: 'inherit',
          color: 'var(--pixel-fg)',
          background: 'var(--pixel-bg)',
          border: 'none',
          padding: '0 6px',
          cursor: 'pointer',
        }}
      >
        {collapsed ? '▲' : '▼'}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Create `AgentDetailPanel.tsx`.**

```tsx
import type { ActivityEntry } from '../../../core/src/messages.js';
import type { OfficeState } from '../office/engine/officeState.js';

interface Props {
  selectedAgentId: number | null;
  agents: number[];
  agentActivity: Record<number, ActivityEntry[]>;
  agentStatuses: Record<number, string>;
  officeState: OfficeState;
  height: number;
  onSelectAgent: (id: number) => void;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

export function AgentDetailPanel({
  selectedAgentId,
  agents,
  agentActivity,
  agentStatuses,
  officeState,
  height,
  onSelectAgent,
}: Props) {
  const selectedCh =
    selectedAgentId !== null ? officeState.characters.get(selectedAgentId) : undefined;
  const showDetail = selectedAgentId !== null && selectedCh;

  return (
    <div
      data-testid="agent-detail-panel"
      className="pixel-panel"
      style={{
        height,
        overflow: 'auto',
        flexShrink: 0,
        background: 'var(--pixel-bg)',
        color: 'var(--pixel-fg)',
      }}
    >
      {!showDetail ? (
        <div data-testid="agent-overview">
          {agents.length === 0 ? (
            <div style={{ padding: 8, opacity: 0.6 }}>No active agents.</div>
          ) : (
            agents.map((id) => {
              const ch = officeState.characters.get(id);
              const last = agentActivity[id]?.at(-1)?.label ?? '';
              return (
                <button
                  key={id}
                  data-testid="agent-overview-row"
                  data-agent-id={id}
                  onClick={() => onSelectAgent(id)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    font: 'inherit',
                    color: 'var(--pixel-fg)',
                    background: 'var(--pixel-bg)',
                    border: 'none',
                    borderBottom: '2px solid var(--pixel-border)',
                    padding: 8,
                    cursor: 'pointer',
                  }}
                >
                  <strong>{ch?.folderName ?? `Agent ${id}`}</strong>
                  {'  '}
                  <span style={{ opacity: 0.7 }}>{agentStatuses[id] ?? 'active'}</span>
                  <div style={{ opacity: 0.6 }}>{last}</div>
                </button>
              );
            })
          )}
        </div>
      ) : (
        <div>
          <div
            data-testid="agent-detail-header"
            data-agent-id={selectedAgentId ?? undefined}
            style={{ padding: 8, borderBottom: '2px solid var(--pixel-border)' }}
          >
            <strong>{selectedCh?.folderName ?? `Agent ${selectedAgentId}`}</strong>
            {'  '}
            <span style={{ opacity: 0.7 }}>
              {agentStatuses[selectedAgentId as number] ?? 'active'}
            </span>
            <div style={{ opacity: 0.6 }}>
              {selectedCh ? `${selectedCh.inputTokens + selectedCh.outputTokens} tokens` : ''}
            </div>
          </div>
          <div data-testid="activity-feed">
            {(agentActivity[selectedAgentId as number] ?? [])
              .slice()
              .reverse()
              .map((e, i) => (
                <div
                  key={`${e.ts}-${i}`}
                  data-testid="activity-entry"
                  style={{ padding: '2px 8px', display: 'flex', gap: 8 }}
                >
                  <span style={{ opacity: 0.5 }}>{fmtTime(e.ts)}</span>
                  <span>{e.label}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create `ProjectLabels.tsx`.** Copy ToolOverlay's import block and world→screen transform verbatim, but render a small label BELOW each character using `ch.folderName`. Skeleton (fill the transform from `ToolOverlay.tsx:105-140`, mirroring its imports and rAF tick at `94-103`):

```tsx
import { useEffect, useState } from 'react';

import {
  CHARACTER_SITTING_OFFSET_PX,
  PROJECT_LABEL_BELOW_OFFSET_PX,
  TILE_SIZE,
} from '../../constants.js';
import { CharacterState } from '../types.js';
import type { OfficeState } from '../engine/officeState.js';
import type { SubagentCharacter } from '../types.js';

interface Props {
  officeState: OfficeState;
  agents: number[];
  subagentCharacters: SubagentCharacter[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.MutableRefObject<{ x: number; y: number }>;
}

export function ProjectLabels({
  officeState,
  agents,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
}: Props) {
  const [, setTick] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setTick((n) => n + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const el = containerRef.current;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const canvasW = Math.round(rect.width * dpr);
  const canvasH = Math.round(rect.height * dpr);
  const layout = officeState.getLayout();
  const mapW = layout.cols * TILE_SIZE * zoom;
  const mapH = layout.rows * TILE_SIZE * zoom;
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x);
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y);

  const ids = [...agents, ...subagentCharacters.map((s) => s.id)];

  return (
    <>
      {ids.map((id) => {
        const ch = officeState.characters.get(id);
        if (!ch || !ch.folderName) return null;
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        const screenX = (deviceOffsetX + ch.x * zoom) / dpr;
        const screenY =
          (deviceOffsetY + (ch.y + sittingOffset + PROJECT_LABEL_BELOW_OFFSET_PX) * zoom) / dpr;
        return (
          <div
            key={id}
            data-testid="project-label"
            data-agent-id={id}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY,
              transform: 'translateX(-50%)',
              pointerEvents: 'none',
              fontSize: 9,
              color: 'var(--pixel-fg)',
              opacity: 0.7,
              whiteSpace: 'nowrap',
            }}
          >
            {ch.folderName}
          </div>
        );
      })}
    </>
  );
}
```

(If `TILE_SIZE`/`CharacterState`/`SubagentCharacter` import paths differ, copy them exactly from `ToolOverlay.tsx`'s import block.)

- [ ] **Step 5: Wire the layout in `App.tsx`.** Add imports:

```typescript
import { AgentDetailPanel } from './components/AgentDetailPanel.js';
import { ResizablePanelDivider } from './components/ResizablePanelDivider.js';
import { ProjectLabels } from './office/components/ProjectLabels.js';
import { DETAIL_PANEL_DEFAULT_HEIGHT, DETAIL_PANEL_HEIGHT_STORAGE_KEY } from './constants.js';
```

Add state inside `App()`:

```typescript
const [panelHeight, setPanelHeight] = useState<number>(() => {
  try {
    const v = parseInt(localStorage.getItem(DETAIL_PANEL_HEIGHT_STORAGE_KEY) ?? '', 10);
    return Number.isFinite(v) ? v : DETAIL_PANEL_DEFAULT_HEIGHT;
  } catch {
    return DETAIL_PANEL_DEFAULT_HEIGHT;
  }
});
const [panelCollapsed, setPanelCollapsed] = useState(false);
useEffect(() => {
  try {
    localStorage.setItem(DETAIL_PANEL_HEIGHT_STORAGE_KEY, String(panelHeight));
  } catch {
    /* ignore */
  }
}, [panelHeight]);
const handleSelectAgentFromPanel = useCallback(
  (id: number) => {
    const os = getOfficeState();
    os.selectedAgentId = id;
    os.cameraFollowId = id;
    handleAgentSelectionChange(id);
  },
  [handleAgentSelectionChange],
);
```

- [ ] **Step 6: Render `ProjectLabels`** inside the overlay layer (next to `<ToolOverlay .../>`, only in the `!isDebugMode` branch):

```tsx
<ProjectLabels
  officeState={officeState}
  agents={agents}
  subagentCharacters={subagentCharacters}
  containerRef={containerRef}
  zoom={editor.zoom}
  panRef={editor.panRef}
/>
```

- [ ] **Step 7: Restructure the root into a gated split.** Replace the single root return. Keep the existing canvas + overlays + modals JSX, but split it so the canvas region carries `containerRef`. Structure:

```tsx
const canvasInner = (
  <>
    <OfficeCanvas /* ...existing props... */ onAgentSelectionChange={handleAgentSelectionChange} />
    {/* existing {!isDebugMode ? (<>...overlays incl ProjectLabels...</>) : (<DebugView .../>)} */}
  </>
);
const modals = (
  <>
    {/* existing HooksInfoModal, BottomToolbar, VersionIndicator, ChangelogModal, SettingsModal, MigrationNotice */}
  </>
);

if (!isBrowserRuntime) {
  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden">
      {canvasInner}
      {modals}
    </div>
  );
}

return (
  <div className="w-full h-full flex flex-col overflow-hidden">
    <div
      ref={containerRef}
      className="relative overflow-hidden"
      style={{ flex: '1 1 0', minHeight: 0 }}
    >
      {canvasInner}
    </div>
    <ResizablePanelDivider
      height={panelHeight}
      onHeightChange={setPanelHeight}
      collapsed={panelCollapsed}
      onToggleCollapse={() => setPanelCollapsed((c) => !c)}
    />
    {!panelCollapsed && (
      <AgentDetailPanel
        selectedAgentId={selectedAgentId}
        agents={agents}
        agentActivity={agentActivity}
        agentStatuses={agentStatuses}
        officeState={officeState}
        height={panelHeight}
        onSelectAgent={handleSelectAgentFromPanel}
      />
    )}
    {modals}
  </div>
);
```

Ensure `agentActivity` and `agentStatuses` are destructured from the `useExtensionMessages()` result in `App()` (add `agentActivity` if not already pulled).

- [ ] **Step 8: Verify build + types + lint.**

Run: `npm run check-types && npm run lint && (cd webview-ui && npm run build)`
Expected: no errors; webview builds.

- [ ] **Step 9: Commit.**

```bash
git add webview-ui/src/components/AgentDetailPanel.tsx webview-ui/src/components/ResizablePanelDivider.tsx webview-ui/src/office/components/ProjectLabels.tsx webview-ui/src/constants.ts webview-ui/src/App.tsx
git commit -m "feat(webview): resizable detail panel, project labels, split layout (standalone)"
```

---

### Task 9: E2E — standalone activity dashboard test + inventory

**Files:**

- Modify: `e2e/tests/standalone/hooks.spec.ts` (add a test in the existing `@area:standalone` describe)
- Modify: `e2e/README.md` (regenerated by `npm run e2e:inventory`)

**Interfaces:**

- Consumes: `launchStandalone`/`standalone` fixture, `sendHookEvent`, `sessionStartStartup`, `setSettings`, message recorder (`standalone.drainMessages`).

- [ ] **Step 1: Add the test.** Append to `e2e/tests/standalone/hooks.spec.ts` (mirror the existing test's imports/fixtures):

```typescript
test('shows agent activity in the detail panel @area:standalone', async ({ page, standalone }) => {
  await setSettings(page, {
    alwaysShowLabels: true,
    hooksEnabled: true,
    watchAllSessions: true,
    debugView: false,
  });
  await standalone.drainMessages();

  const sessionId = 'standalone-activity-test-session';
  const filePath = path.join(standalone.workspaceDir, 'demo.ts');

  await sendHookEvent(
    standalone.hookServerConfig,
    sessionStartStartup(sessionId, standalone.workspaceDir),
  );
  await sendHookEvent(standalone.hookServerConfig, {
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: filePath },
  });

  // Live activity broadcast reached the browser.
  const afterTool = await standalone.drainMessages();
  expect(afterTool.some((m) => m.type === 'agentActivity')).toBe(true);

  // Project label appears under the character (folderName = basename(workspaceDir)).
  const projectName = path.basename(standalone.workspaceDir);
  await expect(page.locator('[data-testid="project-label"]').first()).toHaveText(projectName);

  // Overview row exists; clicking it opens the detail view + requests history.
  const row = page.locator('[data-testid="agent-overview-row"]').first();
  await expect(row).toBeVisible();
  await row.click();

  await expect(page.locator('[data-testid="agent-detail-header"]')).toBeVisible();
  await expect(
    page.locator('[data-testid="activity-entry"]').filter({ hasText: 'Reading demo.ts' }).first(),
  ).toBeVisible();

  const afterSelect = await standalone.drainMessages();
  expect(afterSelect.some((m) => m.type === 'agentActivityHistory')).toBe(true);

  // Divider drag changes the panel height.
  const panel = page.locator('[data-testid="agent-detail-panel"]');
  const before = (await panel.boundingBox())?.height ?? 0;
  const divider = page.locator('[data-testid="detail-panel-divider"]');
  const box = await divider.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 80);
    await page.mouse.up();
  }
  const after = (await panel.boundingBox())?.height ?? 0;
  expect(after).toBeGreaterThan(before);
});
```

- [ ] **Step 2: Run the new test.**

Run: `npm run e2e -- --workers=1 --grep "detail panel"`
Expected: PASS. (If selection/timing is flaky, add a short `await page.waitForTimeout(300)` after the tool hook before reading the row — mirror the existing spec's waits.)

- [ ] **Step 3: Run the existing standalone spec for regressions.**

Run: `npm run e2e -- --workers=1 --grep "standalone"`
Expected: all standalone tests PASS (the split layout must not break existing overlay assertions).

- [ ] **Step 4: Regenerate the inventory.**

Run: `npm run e2e:inventory`
Expected: `e2e/README.md` updated with the new test between the inventory markers.

- [ ] **Step 5: Commit.**

```bash
git add e2e/tests/standalone/hooks.spec.ts e2e/README.md
git commit -m "test(e2e): standalone agent activity detail panel"
```

---

### Task 10: Docs + full verification

**Files:**

- Modify: `CLAUDE.md` (message counts; ServerMessage/ClientMessage tables; webview component list)
- Modify: `docs/superpowers/specs/2026-06-30-agent-activity-dashboard-design.md` (flip Status to "Implemented")

- [ ] **Step 1: Update CLAUDE.md.** In the "AsyncAPI Protocol Contract" section change "26 ServerMessage variants" → "29 ServerMessage variants" and "18 ClientMessage variants" → "19 ClientMessage variants", and note the new `agentActivity` / `agentActivityHistory` (server) and `requestActivity` (client). Add `AgentDetailPanel.tsx`, `ResizablePanelDivider.tsx`, and `office/components/ProjectLabels.tsx` to the webview component list. Add a one-line note that the standalone split layout (canvas top / detail panel bottom) is gated behind `isBrowserRuntime`.

- [ ] **Step 2: Full compile.**

Run: `npm run compile`
Expected: asyncapi generate (no drift), check-types, lint, esbuild, vite all pass.

- [ ] **Step 3: Full unit tests.**

Run: `npm test`
Expected: server + webview suites pass.

- [ ] **Step 4: Commit.**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-06-30-agent-activity-dashboard-design.md
git commit -m "docs: update protocol counts and component list for activity dashboard"
```

- [ ] **Step 5 (optional): Full e2e sweep.**

Run: `npm run e2e -- --workers=1`
Expected: all areas pass (or run at least `spawn`, `lifecycle`, `standalone`).

---

## Self-Review Notes

- **Spec coverage:** layout split (Task 8), resizable divider + collapse (Task 8), project label via `folderName` (Tasks 8, label data confirmed standalone-reliable), detail panel status header + live feed (Task 8), overview when nothing selected (Task 8), server ring buffer (Task 3), `agentActivity`/`agentActivityHistory`/`requestActivity` (Tasks 1/3/5), selection lifted to React (Task 7), `useExtensionMessages` handling (Task 6), error handling = empty entries for unknown agent (Task 5 test), server unit tests (Tasks 2/3/4/5) + standalone e2e (Task 9), CLAUDE.md/doc rollout (Task 10). All covered.
- **Decision deltas vs spec:** (1) the live `agentActivity` reuses the existing `store.broadcast()` channel inside `appendActivity`, so no broadcast-layer wireup changes are needed (simpler than the spec's "translate `activityAppended` → message" — there is no new store event). (2) Correct message counts are 27→29 / 18→19 (spec said 26→28 based on stale CLAUDE.md). (3) Project label uses `folderName` (no protocol change), reliable in hooks mode; file-fallback mode may truncate hyphenated names — acceptable v1 caveat.
- **Type consistency:** `ActivityEntry`/`AgentActivity`/`AgentActivityHistory`/`RequestActivity` names match across Tasks 1/3/5/6; `appendActivity`/`getActivity`/`buildActivityEntry`/`onAgentSelectionChange`/`agentActivity` used consistently.
