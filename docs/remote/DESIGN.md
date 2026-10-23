# Remote sessions: design

Status: approved 2026-10-17 · Branch: `remote-ingest`

## Goal

Every Claude Code session on the account appears in the office — this PC, other
computers, and cloud sessions (claude.ai/code) — with a badge saying where it runs.
The board runs 24x7 on a second monitor.

Success:

- A remote session shows up within ~2 s of its first activity, with a 💻/☁ badge.
- Remote characters show tool activity, the permission bubble, Done/Waiting, and
  Subtask sub-characters; they come back by themselves after a server restart.
- Only the relay's `POST /ingest` routes are reachable from the internet. A leaked remote
  key can post events, and wait for the board's answer to permission requests in its
  own (source-prefixed) sessions, and nothing else.

Out of scope: claude.ai chats (no hooks), the stage track and done-today shelf (later).

## Shape

```
local sessions ─ claude-hook.js (127.0.0.1) ───────────────────────────────┐
                                                                            ▼
other computer ─ async curl + source key ─┐                        Pixel Agents server
                                          ├─ Tailscale Funnel ─ relay ─► 127.0.0.1:3100 (private)
cloud sessions ─ async curl ──────────────┘   https://<pc>.ts.net/ingest
                 (key added by a cloud network secret)
```

### Relay (`remote/relay/`)

Zero-dependency Node, bound to 127.0.0.1. The only process Funnel exposes.

- `POST /ingest` (also `/` in case Funnel strips the mount path). `Authorization: Bearer <key>`
  picks the source. Keys are stored as SHA-256 hashes in `~/.pixel-agents/relay.json`.
- Body ≤ 2 MB, must have string `session_id` and `hook_event_name`.
- Rewrites before forwarding:
  - drops `tool_response` and `transcript_path` (the transcript lives on another machine)
  - truncates long strings inside `tool_input`
  - prefixes `session_id` with `<sourceId>:` so a remote key can never address a local session
  - adds `pixel_source: { id, label, kind }` (`kind` is `computer` or `cloud`)
- Replies `204` before forwarding, so a sender never waits on the board.
- Forwards to the live Pixel Agents server found in `~/.pixel-agents/servers/*.json`
  (`POST /api/hooks/claude`, server's own bearer token). The server token never
  leaves this PC.
- CLI: `serve`, `add-source <id> --label <l> --kind computer|cloud` (prints the key once),
  `remove-source <id>`, `list`.

### Fork changes (server + webview)

`pixel_source` is trusted only because it arrives on the token-authenticated loopback
route, which only local processes can call.

1. **Adoption** (`hookEventHandler.ts`, `agentRuntime.ts`): a remote session is adopted
   as a hooks-only agent (no transcript) regardless of Watch All Sessions. Any event
   for an unknown remote session adopts it, so remote characters return after a
   restart. SessionStart still waits for a confirming event, as it does locally.
2. **Tool ids** (`hookEventHandler.ts`): for hooks-only agents, the hook's
   `tool_use_id` is the tool id for start and done. This lets parallel tools finish
   correctly and lets Task/Agent tools create a Subtask sub-character that is cleared
   on the matching PostToolUse.
3. **Badge** (`asyncapi.yaml` → `agentCreated` / `existingAgents` gain `sourceLabel`
   and `sourceKind`; `ToolOverlay.tsx`): the overlay shows `☁ Cloud` / `💻 Laptop`.
   `directoryName` stays the repo name, so seating is unchanged.
4. **Expiry** (`agentRuntime.ts`): a remote agent with no event for 3 h is removed, because
   a sleeping laptop or killed cloud VM never sends SessionEnd.

### Senders (`remote/senders/`)

The hooks list is the same 12 events Pixel Agents installs locally. Every entry is
`"async": true` and uses `curl -m 5`, so a session never blocks, even when this PC is off.

- **Other computer**: user-level `~/.claude/settings.json`. Key read from
  `~/.pixel-agents/ingest-key`.
- **Cloud**: committed `.claude/settings.json` in each repo. Runs only when
  `CLAUDE_CODE_REMOTE=true`, so it is a no-op on local machines. It carries no key:
  the cloud environment's **network secret** (Bearer, host `<pc>.ts.net`) adds it, and
  that also lets the session reach the host without changing the network access level.

### Approvals (added 2026-10-19)

A sender's `PermissionRequest` gets a second, synchronous hook (`curl -sf -m 650`, hook
`timeout: 660`) that posts to `/ingest/permission`. The relay authenticates it like any
event, long-polls the board's `/api/permissions/wait` with the board token (session id
prefixed, `pixel_source` stamped), and answers `200` with the hook's exact stdout or
`204` (no answer: the sender's terminal decides). The output is rebuilt from validated
fields only and ASCII-escaped; an AskUserQuestion's `updatedInput.answers` is built from
the sender's original tool input. The sender hanging up (its terminal answered) aborts
the board's wait. At most 32 waits are held at once. On the board, a relayed request
only matches a relayed agent, and only its `Stop`/`SessionEnd` resolves it, since async
events can arrive out of order.

## Known limits

- Async hooks can arrive out of order. The worst case is a tool row that stays until
  the turn ends.
- Remote sessions have no context gauge and no team/teammate detection (both need the
  transcript).
- The board only updates while this PC is on. Senders fail silently when it's off.

## Tasks

- [x] Relay: tests, implementation, CLI
- [x] Fork 1: remote adoption + auto-adopt (tests)
- [x] Fork 2: tool_use_id tool tracking + Subtask for hooks-only (tests)
- [x] Fork 3: sourceLabel/sourceKind protocol + overlay badge
- [x] Fork 4: remote expiry (tests)
- [x] Sender templates (`relay.mjs sender-config`) + setup guide (`remote/README.md`)
- [x] Full check suite green (`check-types`, `lint`, tests; 5 pre-existing Windows-only
      server failures in mockClaudeRunner/rotateToken, unchanged)
- [x] End-to-end: fake cloud session through the running relay → board shows
      `☁ Selftest · hobbyfi-web`, Subtask created/cleared, wrong key → 401
- [ ] Run on this PC: build, start on :3100, relay on :3199, auto-start at login
- [ ] Tailscale Funnel (needs user sign-in), end-to-end test with a fake remote event
- [ ] Other computer + cloud environment setup (needs user)
