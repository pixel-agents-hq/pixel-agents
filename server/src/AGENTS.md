# server/src/ - lifecycle runtime, HTTP/WS server, CLI

Score 14 (46 files, ~12.4k LOC, `AgentStateStore` ~15 / `AgentState` ~13 importers). Shared by both hosts; host-specific bits arrive via `RuntimeLifecycleCallbacks`, `StateAdapter`, `TerminalAdapter`.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| JSONL watching, adoption, teammate/background scans | `fileWatcher.ts` | 1.5k+ LOC, biggest hotspot |
| JSONL record -> state | `transcriptParser.ts` | spawn tools (Task/Agent) ALWAYS use JSONL |
| Hook event dispatch | `hookEventHandler.ts` | |
| Webview message dispatch + read-only gate | `clientMessageHandler.ts` | `refuseReadOnly` at the top |
| Fastify routes, `/ws` | `httpServer.ts` | the only Fastify-aware module |
| Token / Host / Origin predicates | `wsAuth.ts` | `standaloneHandshakeVerdict`, `redactTokenQuery` |
| Standalone PTY terminals | `terminal/` | `PtySessionManager`, `terminalRoutes`, `standaloneAgentLauncher`, `ptyModule` |
| Shadow store for unnamed background spawns | `subagentWatch.ts` | ids >= 1,000,000, never broadcast |
| Context gauge | `contextUsage.ts` | |
| Directories + suggestions | `directories.ts`, `directorySuggestions.ts`, `hostDirectory.ts` | |
| Asset decode/merge/reload | `assetLoader.ts`, `assetReload.ts` | uses `core/src/assets` |
| Timing constants | `constants.ts` | |
| Providers | `providers/` | own AGENTS.md |

## CONVENTIONS
- Dependencies injected through constructors/options; no module-level singletons for new code (legacy setters like `setTeamProvider` exist - tests reset them).
- Config namespaced per Adapter (`vscode`/`standalone`); hooks consent/enabled and user Directories are machine-global.
- Boundary validation returns typed result unions; inner code trusts them.
- `terminal/`: routes attach only to PTYs the manager created; availability = lazy, cached `PtySessionManager.probe()` that really spawns (npm >=11.16 leaves `spawn-helper` non-executable - import succeeds, spawn fails). Failure is a reason string, never a startup crash.
- `cli.ts` exports `parseArgs`/`CliArgsError` for tests; `dist/cli.js` keeps `fastify`, `@fastify/*`, `node-pty`, `@lydell/node-pty` external - which is why the ROOT `package.json` must list them.

## ANTI-PATTERNS
- Calling a transport from any module here - mutate `AgentStateStore`, let the broadcast layer translate.
- Claude-specific tool names/record shapes outside `providers/hook/claude/` (except the transcript parser's existing Claude JSONL knowledge).
- Granting privilege from peer address, `Host` or `Origin`; only the token + allowed-Host verdict counts.
- A new `ClientMessage` handler placed before or around `refuseReadOnly`.
- `try { require('node-pty') }` as an availability check.
- Reviving commented-out `EXTERNAL_STALE_TIMEOUT_MS` in `constants.ts` without re-checking stale-check behavior.
- Turn-end background-tool re-sends missing `toolName` + `runInBackground`, or not skipping promoted teammate spawns (`hasPromotedBackgroundAgent`).
