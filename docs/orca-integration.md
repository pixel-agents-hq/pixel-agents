# Orca Integration — Design

**Status:** Design locked, pre-implementation.
**Decisions locked:** **Source A** (Orca host push → `POST /api/hooks/orca`) · **Standalone** deployment (`npx pixel-agents`, WebSocket transport).
**Goal:** Surface **all agents Orca runs** (17 CLI types across multiple workspaces) as animated characters in the Pixel Agents office, with their live status ("현황").

---

## 1. What Orca is (reverse-engineered, evidence-based)

Orca is a **hierarchical multi-agent IDE** — an Electron host on Windows that drives many AI coding CLIs, each in its own PTY/worktree, and relays their activity. Three observability surfaces exist today:

| Surface | Location | Contains | Pixel-Agents analogue |
|---|---|---|---|
| **Hook relay** | WSL `~/.orca-wsl/hook-relay/<ver>/wsl-agent-hook-relay.js` | Normalizes **17 CLI vendors'** hooks into a live stream: `agentType`, `state: working\|idle\|done`, current tool snapshot, prompt / last assistant message | `POST /api/hooks/:providerId` + `HookProvider.normalizeHookEvent` |
| **Runtime API** | `ws://localhost:6768` (+ named pipe) with `authToken`, discovered via `%APPDATA%/Orca/orca-runtime.json` | The live API Orca's own renderer consumes (agents/tasks/gates — inferred) | `server.json` + `WebSocketTransport` |
| **Persisted state** | `%APPDATA%/Orca/` | `orchestration.db` (SQLite: `tasks`, `dispatch_contexts`, `decision_gates`, `messages`, `coordinator_runs`), `orca-stats.json` (`agent_start`/`agent_stop`), `logs/daemon.log` (`session-created/attached/killed`) | `~/.pixel-agents/` |

**Evidence highlights**

- Relay HTTP ingress endpoints prove the 17 supported agent types:
  `amp, antigravity, claude, codex, command-code, copilot, cursor, devin, droid, gemini, grok, hermes, kimi, mimo-code, omp, opencode, pi`
  (each `POST /hook/<type>`, auth header `x-orca-hook-token`, port from env `ORCA_AGENT_HOOK_PORT`).
- Relay's **normalized JSON-RPC vocabulary** forwarded to the host:
  `session.start`, `agent.start`, `tool.call`, `tool.result`, `assistant.message`, `agent.end`, `agent.hook`.
- Relay already maintains a per-agent state model: `{ id, agentType, state: "working"|"idle"|"done", startedAt, prompt, teammate, running }`. **The "current status" the user wants already exists inside Orca** — we are bridging it, not recomputing it.
- Agent identity: `ptyId = <sessionUuid>::<workspaceAbsPath>@@<agentShortHash>` (workspace path embedded; git-worktree based). Two workspaces observed: `…\orca\pixel-agents`, `…\orca\new-game`.
- `orca-runtime.json` exposes `{ runtimeId, pid, transports:[named-pipe, websocket ws://0.0.0.0:6768], authToken, startedAt }`.
- `daemon.log` shows a `client-hello` handshake with roles `control` / `stream` (even a `"health-check"` clientId is accepted).
- `orchestration.db` schema = a **coordinator → tasks → dispatch → decision-gates → inter-agent messages** model.

**Key insight:** Orca is not "another CLI to hook" — it is a **peer aggregator** that has already normalized 17 CLIs. Pixel Agents is *also* an aggregator (hooks/JSONL → office). So this integration is **bridging one hub's normalized agent stream into the other's office**, and the clean seam is a new `orca` `HookProvider` fed by an **Orca source adapter**.

---

## 2. The constraint that shapes everything (pixel-agents side)

Despite CLAUDE.md describing a provider *registry*, the runtime is **hard-wired to one provider today**:

- `AgentRuntime` and `HookEventHandler` each take a single `provider: HookProvider`.
- The URL `providerId` is captured then **discarded** — `HookEventHandler.handleEvent(_providerId, event)` ignores it and always calls `this.provider.normalizeHookEvent` (`server/src/hookEventHandler.ts:132`).
- `AgentState.providerId` exists (`server/src/types.ts:37`) but is **never assigned, never persisted, never sent to the webview**. There is **no "agent type" reaching the UI** — appearance is only `palette (0–5)` + `hueShift`; `Character` has no name/type/badge field.

So "add Orca" is really three things:
1. **Make the runtime actually multi-provider** (fulfill the architecture's own promise).
2. **Add per-agent type identity end-to-end**, mirroring the existing team-info plumbing.
3. **Bridge Orca's event stream** into a new `orca` provider.

---

## 3. Architecture

```
                         ┌───────────────────────── pixel-agents (server) ─────────────────────────┐
 Orca (source of truth)  │                                                                          │
                         │   Orca source adapter ──▶ orcaProvider.normalizeHookEvent() ──▶ AgentEvent │
 [A] host push  ─────────┼──▶ POST /api/hooks/orca ─┐                                      │        │
 [B] ws://:6768 client ──┼──▶ OrcaWsBridge ─────────┼─▶ (providerId="orca") ─▶ HookEventHandler       │
 [C] file-tail read model┼──▶ OrcaFileBridge ───────┘        selects provider by id ─▶ AgentStateStore │
                         │                                              │                  │        │
                         │                          multi-provider: Map<providerId,Provider>│broadcast│
                         └──────────────────────────────────────────────────────────┼──────┼────────┘
                                                                                     ▼      ▼
                                                                   PostMessage / WebSocket ─▶ Office UI
                                                                   (per-type badge, per-workspace grouping)
```

**Two decoupled pieces:**

- **`orcaProvider` (stable, pure, testable):** a `HookProvider` (`protocolVersion = 1`) whose `normalizeHookEvent` maps Orca's `{session.start, agent.start, tool.call, tool.result, assistant.message, agent.end}` → pixel-agents' `AgentEvent` union (`toolStart/toolEnd/turnEnd/sessionStart/sessionEnd/permissionRequest/subagent*`). Carries `agentType` through. No knowledge of *how* events arrive.
- **Orca source adapter (swappable transport):** obtains Orca events by one of the three sources below and feeds them to the provider. This is the only part that differs per source.

---

## 4. Source options (how Orca events reach the provider)

| | **[A] Host push → `/api/hooks/orca`** | **[B] Runtime WS client `ws://:6768`** | **[C] File-tail read model** |
|---|---|---|---|
| Orca change needed | **Yes** (a few lines: forward its normalized stream) | No | No |
| Data richness | ★★★ full: 17 types, tool-level, working/idle/done, prompt | ★★★ potentially richest (what Orca's UI uses: tasks/gates/msgs) | ★★ lifecycle + tasks/gates via DB; weak tool-level for non-Claude |
| Freshness | push, instant | push, instant | polling (aligns with existing hybrid poller) |
| Coupling / brittleness | low (uses stable hook contract) | **high** (undocumented, versioned internal API) | medium (couples to Orca file/DB schemas; both carry `schemaVersion`) |
| Reverse-engineering risk | none | **high** — handshake + possible **E2EE** (`orca-e2ee-keypair.json` present) | low (formats are readable now) |
| Pixel-agents work | provider + multi-provider refactor only | + WS client + protocol impl + crypto | + file/DB tailers |

**Feasibility notes**
- **[A]** The ingress guard requires each POST body to include `session_id` + `hook_event_name` (`httpServer.ts:119-128`), Bearer token from `~/.pixel-agents/server.json`, ≤64 KB. Orca's forwarder shapes events to that (ptyId → `session_id`, orca kind → `hook_event_name`). This is the **same pattern a hook script uses** — minimal, decoupled, robust.
- **[B]** WS is bound `0.0.0.0:6768` → reachable from WSL via the Windows host IP; token is in `orca-runtime.json`. But the message protocol is unknown and may be E2EE. **Requires a reverse-engineering spike before committing.**
- **[C]** pixel-agents runs in WSL; Orca data is on Windows FS (`/mnt/c/Users/<u>/AppData/Roaming/Orca/…`). `fs.watch` on DrvFs is unreliable → **use polling** (pixel-agents already does hybrid polling — good fit). SQLite must be opened **read-only** with WAL awareness. Gives strong presence + task/gate/coordinator hierarchy; tool-by-tool animation for non-Claude agents is limited.

---

## 5. Recommendation — phased

- **Phase 0 — MVP, zero-Orca-change (Source C):** tail `daemon.log` + `orca-stats.json` (+ `orchestration.db` for task/gate/coordinator richness). Fills the office with Orca agents grouped by workspace, badged by type, showing presence + task/waiting/decision-gate status. Ships value with no dependency on Orca's cooperation and **validates the new UI** (type badges, multi-workspace).
- **Phase 1 — full fidelity (Source A):** if we may add a few lines to the Orca host, switch the bridge to consume Orca's normalized live stream via `POST /api/hooks/orca` — tool-level `working/idle/done` for all 17 types, push-fresh, least brittle.
- **Source B** is the upgrade path **only if** we need live push but cannot modify Orca — and only after a protocol/E2EE spike proves it viable.

The `orcaProvider` (§3) is identical across all three; only the source adapter swaps. So Phase 0 is not throwaway.

---

## 6. Data-model mapping (Orca → Pixel Agents)

| Orca concept | Source | Pixel-Agents mapping |
|---|---|---|
| Agent instance (`ptyId`) | relay / stats / daemon.log | one `Character`; `sessionId = ptyId`; numeric `id` = stable hash of ptyId; `folderName = basename(workspacePath)` |
| `agentType` (claude/codex/cursor/…) | relay hook path | **NEW** `agentType` field → per-type **badge + hue tint** |
| workspace path (in ptyId) | ptyId | `projectDir` / group-by-workspace in office |
| `state: working` | relay | `AgentStatus{active}` + typing/reading animation |
| `state: idle` (turn end, awaiting input) | relay | `AgentStatus{waiting}` → green ✓ bubble + chime |
| `state: done` / `agent.end` | relay / `agent_stop` | tools clear; character persists or despawns (matrix effect) |
| current tool (`tool.call`/`tool.result`) | relay | `AgentToolStart/Done` + `formatToolStatus` → activity feed + anim |
| prompt / last assistant message | relay | `ActivityEntry.label` + `AgentDetailPanel` |
| `coordinator_runs` + `tasks(parent_id)` | `orchestration.db` | **Lead + teammates/subagents** (coordinator = lead; child tasks = teammates) — reuse existing team plumbing |
| `decision_gates(status)` | `orchestration.db` | permission **"…" amber bubble** (awaiting human approval) |
| `dispatch_contexts(task_id,status)` | `orchestration.db` | which agent is on which task (detail panel) |
| `messages(thread_id, inbox)` | `orchestration.db` | (future) inter-agent chatter overlay |

Orca's coordinator/tasks/gates map cleanly onto pixel-agents' existing **Lead+Teammates** and **permission-bubble** concepts — little new UI vocabulary is required beyond agent-type identity.

---

## 7. Concrete pixel-agents changes (by layer)

**A. Multi-provider runtime (principled, small)**
- Introduce `Map<providerId, HookProvider>` in `AgentRuntime`; `HookEventHandler.handleEvent` selects `providers.get(providerId)` instead of ignoring it (`hookEventHandler.ts:132`).
- Register `claudeProvider` + `orcaProvider` in `server/src/providers/index.ts` and in `cli.ts` composition.

**B. New provider dir `server/src/providers/hook/orca/`**
- `orca.ts` — `HookProvider` impl: `normalizeHookEvent`, `formatToolStatus`, `permissionExemptTools`/`subagentToolNames`/`readingTools`, `protocolVersion = 1`, `id='orca'`.
- `constants.ts` — 17 agentType strings, Orca event-kind names, AppData/relay paths.
- Source adapter(s): `orcaFileBridge.ts` (Phase 0) and/or `orcaPushIngest` (Phase 1 uses existing route) / `orcaWsBridge.ts` (Source B).
- Optional `orcaTeamProvider.ts` — coordinator/tasks → `TeamProvider` semantics.

**C. Per-agent type identity, end-to-end** (mirror team-info path)
- `agentType?: string` on `AgentState` (`types.ts`), `PersistedAgent` (`types.ts` + `core/src/schemas.ts`), `agentStateStore.persist`.
- Protocol: add `agentType` to `AgentCreated` (both emitters already attach undeclared extras) **or** a dedicated `AgentProviderInfo` message in `core/asyncapi.yaml` → regenerate `core/src/messages.ts` (CI drift check).
- Webview: `agentType` on `Character` (`office/types.ts`); `OfficeState.setProviderInfo` (mirror `setTeamInfo`); read in `useExtensionMessages` `agentCreated` handler.
- Render: type **badge/label** (mirror `ProjectLabels`) and/or **hue tint** per type via existing `adjustSprite`; show type in `AgentDetailPanel`.

**D. Discovery + config**
- Auto-detect Orca AppData path (WSL→Windows: `/mnt/c/Users/<user>/AppData/Roaming/Orca`); read `orca-runtime.json` for Source B.
- New per-namespace settings: `orcaEnabled`, `orcaAppDataPath?`, `orcaRuntimeSource: 'file'|'ws'|'push'`. Add `ClientMessage` toggle + `SettingsModal` entry.

**E. Composition (standalone-first)**
- Start the Orca bridge in `cli.ts:main()` after `server.start()` (port/token in scope). Orca is its own IDE → pixel-agents runs as `npx pixel-agents` alongside it (or later embedded as an Orca panel/webview).

**F. Tests**
- Server unit: `orca.normalizeHookEvent` per agentType × event kind; bridge parsers against `orca-stats.json`/`daemon.log`/`orchestration.db` fixtures; multi-provider routing in `hookEventHandler.test.ts`.
- E2E: `mock-orca` fixture feeding the bridge (mirrors `mock-claude`); assert characters appear per workspace, badged by type, with status transitions.

---

## 8. Risks & open questions

- **[B] WS protocol** undocumented + possible **E2EE** → spike required before commit.
- **[C] internal schemas** (DB/JSON) are unstable contracts across Orca versions → guard with `schemaVersion` checks + try/catch graceful degradation.
- **Windows↔WSL:** path translation; DrvFs `fs.watch` unreliable → poll; WS via Windows host IP.
- **Identity churn:** `ptyId` hash changes across restarts/worktrees → dedupe by ptyId; decide persistence policy for Orca agents (likely ephemeral/non-persisted, like subagents).
- **Office composition:** one shared office vs group-by-workspace "rooms"; do Orca agents coexist with directly-launched Claude agents or is Orca the sole source in this deployment?

---

## 9. Decisions needed before implementation

1. ✅ **Modify Orca host** → **Source A** chosen.
2. ✅ **Deployment** → **Standalone** (`npx pixel-agents`) chosen.
3. (Default-able) **Office layout:** default to **single shared office, grouped/labelled by workspace** (reuses `folderName` labels); revisit "rooms" later.

---

## 10. Locked architecture (Source A + Standalone)

```
 Windows                                   │  WSL
 ┌────────────── Orca host (Electron) ─────┼──────────────────────────────────────────┐
 │  consumes relay's normalized stream     │   ~/.orca-wsl/hook-relay (stdio → host)    │
 │  ┌────────────────────────────────────┐ │                                           │
 │  │ NEW: pixel-agents forwarder        │ │   npx pixel-agents  (127.0.0.1:3100)       │
 │  │  for each normalized agent event:  │ │   ┌─────────────────────────────────────┐ │
 │  │  POST /api/hooks/orca  ────────────┼─┼──▶│ orcaProvider.normalizeHookEvent()   │ │
 │  │  Bearer <token from server.json>   │ │   │ → AgentEvent → AgentStateStore      │ │
 │  └────────────────────────────────────┘ │   │ → WS broadcast → Office (browser)   │ │
 └──────────────────────────────────────────┼──└─────────────────────────────────────┘ │
                                             └──────────────────────────────────────────┘
```

**Where the forwarder lives (one Orca-side detail to confirm):**
- **Recommended — Orca host forwarder:** the host already receives every normalized event over stdio; add a fire-and-forget POST to pixel-agents. Durable (survives relay auto-updates from `orca-updater`). Crosses Windows→WSL: reachable via **WSL2 localhost forwarding** (`http://localhost:3100` from Windows) or the WSL host IP; token read from `\\wsl.localhost\<distro>\home\<user>\.pixel-agents\server.json`.
- **Alternative — relay forwarder (WSL→WSL):** add a second sink beside `forward: a => r.notify("agent.hook", …)`. Same network namespace as pixel-agents (trivial localhost + same-home `server.json`), but lives in the versioned/minified relay bundle → may be overwritten on update unless built from Orca source.

**Push body contract** (must satisfy ingress guard `session_id` + `hook_event_name`, ≤64 KB, `Authorization: Bearer <token>`):
```jsonc
POST /api/hooks/orca
{
  "session_id": "<ptyId>",            // <uuid>::<workspaceAbsPath>@@<hash>
  "hook_event_name": "agent.start",   // orca kind: session.start|agent.start|tool.call|tool.result|assistant.message|agent.end
  "agent_type": "codex",              // one of the 17
  "tool": { "name": "Read", "input": { … } },   // for tool.call/tool.result
  "prompt": "…", "state": "working"   // optional enrichment
}
```
`orcaProvider` (id `orca`, `protocolVersion = 1`) translates this into the `AgentEvent` union.

---

## 11. Implementation plan (sequenced, each milestone independently testable)

> Prereq: dev env is **not set up** in this checkout (`node_modules`/`dist` absent) — `npm install && npm run compile` before M1.

- **M1 — Multi-provider foundation** *(pixel-agents only; no Orca dependency)*
  Refactor `HookEventHandler` to select the provider from a `Map<providerId, HookProvider>` instead of ignoring `_providerId` (`hookEventHandler.ts:132`); register `claude`. Behaviour identical for Claude. Unit-test routing. Fulfils the registry CLAUDE.md already describes.

- **M2 — Agent-type identity, end-to-end** *(pixel-agents only)*
  Thread a new `agentType` field: `AgentState` → `PersistedAgent` (`types.ts` + `schemas.ts`) → `agentStateStore.persist` → protocol (`agentType` on `AgentCreated` **or** new `AgentProviderInfo` in `asyncapi.yaml`; regen `messages.ts` + drift check) → `Character` → `OfficeState.setProviderInfo` (mirror `setTeamInfo`) → `useExtensionMessages` → renderer **badge/hue tint** + `AgentDetailPanel`. Validate with `claude` agents tagged `agentType='claude'`.

- **M3 — `orca` provider (pure translation)** *(no live Orca needed)*
  `server/src/providers/hook/orca/{orca.ts,constants.ts}`. `normalizeHookEvent` maps orca kinds → `AgentEvent`, `sessionId = ptyId`, extracts `agent_type`, `formatToolStatus`, tool sets. Heavy unit tests over synthetic payloads (17 types × event kinds). Register in the M1 map.

- **M4 — Orca push + adoption** *(the integration goes live)*
  Orca-side forwarder (§10). Pixel-agents: ensure a new `orca` ptyId is adopted as an agent (`onExternalSessionDetected` / `store.set`), workspace path → `folderName`/`projectDir`. E2E-by-hand: run Orca → characters appear per workspace, badged by type, status live.

- **M5 — Rich status + polish**
  Map `coordinator_runs`/`tasks(parent_id)` → Lead+Teammates; `decision_gates(status)` → permission "…" bubbles. Group by workspace. `orcaEnabled` setting + `SettingsModal`. `mock-orca` E2E fixture (mirrors `mock-claude`).

---

## 12. UI / Office layout — design preview (locked 2026-07-14)

Before implementation we built an interactive pixel-art preview of the integrated **standalone** office to validate the new UI (type identity, multi-workspace grouping, live status). It ships in-repo, fully self-contained (no external assets — opens directly in a browser):

- **`docs/orca-integration-preview.html`** — canvas-rendered office in the real pixel-agents aesthetic (sharp corners, hard offset shadows, monospace UI). Click any agent to drive the `AgentDetailPanel` header + live activity feed; the right rail lists all 17 Orca-normalized types.

### 12.1 Locked layout

| Decision | Value |
|---|---|
| **Pixel screen aspect** | **16:5** cinematic band on desktop (`aspect-ratio: 16/5`, guard `max-height: 62vh`). The office art buffer is authored at 16:5 (**1152×360**) so it fills the band with no letterbox. |
| **Mobile (≤760px)** | **Keep the current stacked layout** — the stage flexes to fill height, `AgentDetailPanel` + type legend stack below. 16:5 is *not* forced (a full-width 16:5 band is too short on phones). |
| **Vertical composition** | topbar · 16:5 office · divider · dock (`AgentDetailPanel` + legend, absorbs leftover height) · toolbar. |
| **Workspace grouping** | Single shared office, **grouped into per-workspace "rooms"** (rugs + labelled chips), laid left→right by workspace. Matches the design §9.3 default (`folderName` labels; revisit true "rooms" later). |

### 12.2 Visual language → design decision

| Office element | Maps to | Milestone |
|---|---|---|
| Per-type **badge + hue tint** (claude=clay, codex=green, gemini=blue, …) | `agentType` identity end-to-end + per-type tint via `adjustSprite` | **M2** |
| Per-workspace **rooms / labels** | ptyId workspace path → `folderName` / group-by-workspace | M4 |
| **Coordinator bracket + LEAD chip** (lead → teammates) | `coordinator_runs` / `tasks(parent_id)` → reuse Lead+Teammates plumbing | M5 |
| **Green ✓ bubble** + chime | `state: idle` → `AgentStatus{waiting}` | M4 |
| **Amber "…" bubble** | `decision_gates(status)` → permission bubble | M5 |
| **Monitor glow + typing** / **matrix despawn** | `state: working` animation / `agent.end` despawn | M4 |
| **Live activity feed** (`tool.call` / `tool.result` / `assistant.message`) | Orca normalized event stream → `AgentDetailPanel` | M2 / M4 |
| **17-type legend** (live highlighted, rest dimmed) | full catalog of Orca-normalized agent types | M2 |

### 12.3 Still open (revisit with real devices)

- **Mobile office size:** a 16:5 band fit-to-width shrinks characters on phones. Candidate fallbacks if it reads too small: (a) horizontal-scroll the office at native size, or (b) stack the two workspace rooms vertically on mobile. Deferred until tested on a real phone.
- **Type-expression density:** badge + hue tint together may be busy at scale; could drop to hue-only or badge-only.
- **Done agents:** matrix-despawn vs. dimmed-persist.

> The preview is a **design mock**, not production code — its agent list, feed entries, and ptyIds are illustrative (the mocked office is, fittingly, the team building this very integration). The real UI is produced by M2's renderer changes.
