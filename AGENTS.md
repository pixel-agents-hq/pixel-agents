# PROJECT KNOWLEDGE BASE

**Generated:** 2026-11-03
**Commit:** b1bafd0
**Branch:** main

## OVERVIEW
Pixel-art office where AI coding agents (Claude Code today) become animated characters. One TypeScript tree ships two adapters: a VS Code extension and the `npx pixel-agents` standalone server (Fastify + React 19/Canvas SPA). npm workspaces: `server`, `webview-ui`.

Canonical sources: `CLAUDE.md` (full compressed reference; this file only navigates it) and `CONTEXT.md` (glossary: Agent, Sub-agent, Teammate, Lead, Adopt, Headless agent, Read-only office, ...). Use glossary terms in code, comments and docs.

## STRUCTURE
```
pixel-agents/
├── core/              # asyncapi.yaml contract, provider/adapter interfaces, shared asset decoder
├── server/src/        # AgentRuntime, store, Fastify /ws + hooks, CLI, standalone PTY terminal
│   └── providers/     # registry, consent policy/executor, Claude provider + installer + hook script
├── server/__tests__/  # Vitest suite (38 files)
├── adapters/vscode/   # extension activate, webview bridge, terminal agents, legacy migration
├── webview-ui/        # React + Canvas office (depends only on core/)
├── e2e/               # Playwright: VS Code Electron + standalone specs, mock-claude
├── eslint-rules/      # pixel-agents-rules.mjs (custom lint, error level)
├── scripts/           # message codegen, e2e runner/inventory, npm package contract, html tools
├── docs/              # adr/0001 consent, adr/0002 protocol-follows-glossary, design/, research/
└── esbuild.js         # extension + CLI + hook-script bundles
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Protocol message add/change | `core/asyncapi.yaml` -> `npm run asyncapi:generate` | see `core/AGENTS.md` |
| Agent lifecycle, timers, scanners | `server/src/agentRuntime.ts`, `hookEventHandler.ts` | `server/src/AGENTS.md` |
| New CLI integration | `server/src/providers/hook/<id>/` | `server/src/providers/AGENTS.md` |
| Hooks consent / install | `providers/hook/consentGate.ts`, `consentExecutor.ts`, `claude/claudeHookInstaller.ts` | `docs/adr/0001` |
| `/ws` auth, privilege | `server/src/wsAuth.ts`, `clientMessageHandler.ts` | `docs/design/standalone-terminal.md` |
| VS Code wiring | `adapters/vscode/` | `adapters/vscode/AGENTS.md` |
| Webview message handling | `webview-ui/src/hooks/useExtensionMessages.ts` | `webview-ui/AGENTS.md` |
| Game world, renderer, editor | `webview-ui/src/office/` | `webview-ui/src/office/AGENTS.md` |
| Terminal, clipboard, touch selection | `webview-ui/src/terminal/` | `webview-ui/src/terminal/AGENTS.md` |
| Server tests | `server/__tests__/` | `server/__tests__/AGENTS.md` |
| E2E specs | `e2e/` | `e2e/AGENTS.md` + `e2e/README.md` "Mocking model & rules" |
| Claude transcript formats | `docs/research/claude-harness-spawn-formats.md` | 2.1.170-2.1.220 |

## CODE MAP
| Symbol | Type | Location | Refs (files) | Role |
|--------|------|----------|------|------|
| `AgentRuntime` | class | `server/src/agentRuntime.ts` | 15 | lifecycle core both adapters compose (`new AgentRuntime(store, provider)`) |
| `AgentStateStore` | class | `server/src/agentStateStore.ts` | 20+ | single source of truth; broadcasts via store events |
| `HookProvider` | interface | `core/src/provider.ts` | 18 | integration boundary per CLI |
| `AgentEvent` | union | `core/src/provider.ts` | 4 | canonical event; runtime dispatches on `.kind` |
| `TeamProvider` | interface | `core/src/teamProvider.ts` | 6 | Lead + Teammate queries |
| `SessionRouter` | class | `server/src/sessionRouter.ts` | 5 | session_id -> agent_id, buffering |
| `handleClientMessage` | fn | `server/src/clientMessageHandler.ts` | 4 | one dispatch for ClientMessage; read-only gate at top |
| `standaloneHandshakeVerdict` | fn | `server/src/wsAuth.ts` | 7 | token AND allowed Host -> privileged |
| `MessageTransport` | interface | `core/src/transport.ts` | 7 | postMessage vs WebSocket |
| `createTransport` | fn | `webview-ui/src/transport/index.ts` | 1 | ONLY runtime branch point in the UI |
| `OfficeState` | class | `webview-ui/src/office/engine/officeState.ts` | 20+ | imperative game world (not React state) |
| `useExtensionMessages` | hook | `webview-ui/src/hooks/useExtensionMessages.ts` | 20+ | ServerMessage -> OfficeState mutations |

## CONVENTIONS
- Strict layering: `core/` depends on nothing; `server/` and `webview-ui/` only on `core/`; `adapters/vscode/` on `core/` + `server/`. CLI never imports `adapters/vscode/`. Intentional exception: `adapters/vscode/constants.ts` re-exports `server/src/constants.js`. `core/src/assets/` is runtime code shared by server and webview.
- No module under `server/` calls a transport directly; mutate the store, the broadcast layer translates.
- Runtime dispatches on `AgentEvent.kind`, never on CLI tool names. Claude specifics live only in `providers/hook/claude/`.
- Magic numbers/strings live in the per-layer `constants.ts`, CSS vars in `webview-ui/src/index.css :root`.
- No `enum` (use `as const`), `import type` for types, `.js` extensions on relative imports in server/extension.
- PR titles: lowercase conventional commits (`pr-title.yml`).

## ANTI-PATTERNS (THIS PROJECT)
- NEVER hand-edit `core/src/messages.ts` (generated). CI and pre-push regenerate and fail on `git diff`.
- NEVER let `e2e/README.md` inventory drift; regenerate with `npm run e2e:inventory`.
- NEVER run VS Code e2e (`e2e/tests/claude/**`) without explicit user approval; run once at the end, NEVER from a subagent. Subagents use typecheck, lint, unit tests, standalone specs.
- NEVER inline colors (hex/rgb/hsl only in `constants.ts`), blurred shadows, or non-FS-Pixel-Sans fonts: `eslint-rules` enforce these at error level.
- NEVER grant privilege by network position (peer IP, Host, Origin). An unprivileged `/ws` client is read-only: `webviewReady` only; every new message type is privileged by default.
- NEVER persist the hooks preference before install/uninstall settled and disk agrees.
- NEVER drop `fastify`/`@fastify/*`/node-pty from root deps: `dist/cli.js` keeps them external.
- Tests: no fixed sleeps; await the exact event. Real `claude` is never invoked (mock-claude).

## UNIQUE STYLES
- Pixel UI: `borderRadius: 0`, `2px solid` borders, hard `2px 2px 0px` shadows, integer zoom, no `ctx.scale(dpr)`.
- Gesture logic = pure reducers + thin DOM adapters with detached-target rescue listeners.
- Terminal copy is verbatim by default; re-flow is opt-in (Alt+C / "Copy as text").

## COMMANDS
```bash
npm install                    # root + workspaces
npm run compile                # asyncapi:generate, check-types, lint, esbuild, vite
npm run check-types && npm run lint
npm test                       # webview + server Vitest + node --test package contract
npm run asyncapi:generate      # regen core/src/messages.ts
npm run e2e:inventory          # regen e2e/README.md inventory
npm run e2e -- --workers=1 --grep "<test>"   # standalone OK; VS Code specs need approval
npm run watch                  # esbuild + tsc; run `cd webview-ui && npm run dev` separately
```

## NOTES
- Hooks: `.husky/pre-commit` gitleaks + lint-staged; `.husky/pre-push` check-types + both drift checks.
- CLAUDE.md drift (verified in code): npm `files` ships `dist/extension.js` and `dist/uninstall.js`, NOT `core/asyncapi.yaml` and NO `.map` (`scripts/npm-package-contract.mjs` enforces); `server/__tests__` has 38 files, not 28; `AgentRuntime` takes positional `(store, provider)`.
- `npm run import-tileset` is stale (script missing). `esbuild.js --watch` rebuilds only the extension entry.
- Releases use npm OIDC trusted publishing; Dependabot covers root only.
