# server/__tests__/ - server Vitest suite

Score 9, distinct domain (test conventions differ from source). 38 flat `*.test.ts`, ~12.6k LOC, no shared helper module. CLAUDE.md's "28 files" is stale.

## WHERE TO LOOK
| Area | Files |
|------|-------|
| Client protocol + read-only gate | `clientMessageHandler.test.ts` (1.3k LOC) |
| settings.json install/uninstall | `claudeHookInstaller.test.ts` (1k LOC) |
| Consent over the wire / policy / copy | `consentFlow`, `consentGate`, `consentCopy` |
| Hook dispatch, routing | `hookEventHandler`, `sessionRouter` |
| Sidecar background agents, teams | `backgroundAgents`, `claudeTeamProvider`, `teamUtils` |
| `/ws` and terminal auth | `httpServerWs`, `wsAuth`, `terminalRoutes`, `httpServerLog` |
| PTY lifecycle | `ptySessionManager`, `standaloneAgentLauncher`, `terminalFrames` |
| Built artifacts | `cli.test.ts` (`dist/cli.js`), `claude-hook.test.ts` (`dist/hooks/claude-hook.js`) |
| Cross-boundary | `migrateVsCodeState` (adapter code), `mockClaudeRunner` (e2e runner), `fileWatcherDismissal` (mocks `vscode`) |

## CONVENTIONS
- Config: `vitest.config.ts` (`globals`, 10 s timeout, Allure -> `../allure-results/server`); typecheck via `tsconfig.test.json` (ESNext/node resolution) - still write `.js` relative specifiers.
- HOME isolation, one of two idioms: (a) `process.env.HOME` (+ `USERPROFILE` when spawning) to a `mkdtemp` dir in `beforeEach`; (b) `vi.mock('os')` returning a mutable tmp `homedir`, then top-level `await import('../src/...')` so import-time `homedir()` sees it.
- ESM fault injection: `vi.mock('fs')` around `vi.importActual` with toggle flags (`spyOn` cannot redefine ESM `fs`).
- Fake `PtyModule`/`IPty` only; never a real process.
- `createTestAgent(overrides)` is copied inline in many files - a new required `AgentState` field means updating every copy.
- `/ws` rejection: `@fastify/websocket` fires `'open'` before the route rejects; wait the settle window and assert `closeCode`, not `'open'`.

## ANTI-PATTERNS
- Early `return` when a bundle is missing - use `it.skipIf(!fs.existsSync(...))` so it reports as skipped.
- Touching the real `~/.pixel-agents` or `~/.claude/settings.json`.
- Static import of the module under test above its `vi.mock`.
- Leaking module-level state: reset `setPaletteCount`, `setTeamProvider(undefined)`, `setSubagentWatch(undefined)` in `afterEach`.
- Running the PTY probe eagerly - tests pin it lazy and cached.
- Letting shadow-store ids (>= 1,000,000) reach a broadcast assertion as a real agent.
