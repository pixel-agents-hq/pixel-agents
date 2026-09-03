# OpenCode provider

OpenCode sessions appear in the office as hooks-only external agents — no
transcript files involved. A small bridge plugin installed into OpenCode's
global plugin directory reports bus events to the Pixel Agents server, and
the OpenCode provider (`server/src/providers/hook/opencode/`) normalizes
them into the shared `AgentEvent` model.

## Files

| Path                                                               | Role                                                                                                                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/providers/hook/opencode/opencode.ts`                   | `HookProvider` implementation: envelope normalization, tool status text, tool sets                                                                                      |
| `server/src/providers/hook/opencode/bridge/pixel-agents-bridge.ts` | Self-contained OpenCode plugin (zero repo imports; runs under Bun). Maps bus events to hook envelopes and POSTs them to every live server in `~/.pixel-agents/servers/` |
| `server/src/providers/hook/opencode/opencodeBridgeInstaller.ts`    | Install / uninstall / status. Owns exactly one file: `~/.config/opencode/plugins/pixel-agents.ts`                                                                       |
| `server/src/providers/hook/opencode/constants.ts`                  | File names, marker, modes                                                                                                                                               |
| `server/src/providers/hook/opencode/consentCopy.ts`                | First-run consent disclosure                                                                                                                                            |

## Event mapping (bus event → envelope → AgentEvent)

| OpenCode bus event                          | Envelope                                                        | AgentEvent                               |
| ------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------- |
| `session.created`                           | `SessionStart` (+ `cwd` from `info.directory`)                  | `sessionStart`                           |
| `session.deleted`                           | `SessionEnd` (reason `exit`)                                    | `sessionEnd`                             |
| `session.idle`                              | `Stop`                                                          | `turnEnd` (Done)                         |
| `tool.execute.before`                       | `PreToolUse` (`tool_name`, `tool_input`, `call_id`)             | `toolStart` (`hook-<callId>`)            |
| `tool.execute.after`                        | `PostToolUse` / `PostToolUseFailure` (non-zero `metadata.exit`) | `toolEnd`                                |
| `task` + `subagent_type`, before            | `SubagentStart` (type as `tool_name`)                           | `subagentStart` (parent `hook-<callId>`) |
| `task` + `subagent_type`, after             | `SubagentStop`                                                  | `subagentEnd`                            |
| `permission.asked` (alias `permission.ask`) | `PermissionRequest`                                             | `permissionRequest`                      |

Tool names are OpenCode's lowercase ids (`read`, `edit`, `bash`, `task`,
`skill`, …). Status text reuses the Claude prefixes (`Reading x.ts`,
`Running: …`, `Subtask: …`) so character animations work with no webview
change; the `providerCapabilities` broadcast carries the union of all
registered providers' tool sets.

## Install semantics

- Identity is the marker comment, not the path: a same-named file without
  the marker is the user's and install/uninstall refuse to touch it.
- No backup: the installer only ever replaces a file carrying our own
  marker, so there is no user content to preserve.
- The bridge reads the server registry at event time (same protocol as
  `claude-hook.js`: live `servers/*.json` entries, legacy `server.json`
  fallback, dead-PID skip, 2 s best-effort POST). No server URL or token is
  ever written into the plugin file.

## Known limits (MVP)

- No permission-timer heuristics and no context gauge denominator:
  `contextWindowForModel` is unset (OpenCode spans many models/providers),
  so the runtime keeps its estimate and widens on evidence.
- Subagents render as basic sub-agent characters (no Agent Teams equivalent).
- `session.deleted` always despawns; OpenCode has no `/clear`-style
  session-handoff event to rebind.
- Enabling works through the per-provider Settings toggle / consent ask.
  The standalone startup auto-install block is still Claude-only.
- No Playwright e2e spec yet — coverage is unit + installer + dispatch
  tests plus manual-hook `.http` examples (`@provider = opencode`).

## Manual test

1. `npm run build`, then `node dist/cli.js --port 3100` from a workspace.
2. Enable the OpenCode toggle in Settings (installs the bridge plugin), or
   POST the envelopes in `server/manual-hook-events.http` (`@provider =
opencode`) with `port`/`token` from `~/.pixel-agents/servers/`.
3. Run an OpenCode session in the workspace: its character spawns on the
   first tool call, animates per tool, bubbles on permission, and despawns
   when the session is deleted.
