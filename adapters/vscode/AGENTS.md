# adapters/vscode/ - VS Code host adapter

Score 9, distinct domain (only code that may `import 'vscode'`). 8 files, ~2k LOC; two large hubs: `PixelAgentsViewProvider.ts` (~1.15k) and `agentManager.ts` (~565).

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Activation, server boot, migration warning | `extension.ts` | |
| Webview bridge, settings, consent effects | `PixelAgentsViewProvider.ts` | composes `AgentRuntime` + `handleClientMessage` |
| Launch / restore / persist terminal agents | `agentManager.ts` | `claude --session-id <uuid>` |
| Terminal management seam | `vscodeTerminalAdapter.ts` | implements core `TerminalAdapter` |
| Host Directories (workspace folders) | `hostDirectories.ts` | the ONE place building `source: 'host'` entries |
| globalState keys, layout-file contract | `constants.ts` | `pixel-agents.*` namespace |
| Extension removal cleanup | `uninstall.ts` | bundled to `dist/uninstall.js` (`vscode:uninstall`) |
| Legacy state migration | `migrateVsCodeState.ts` | tested from `server/__tests__/migrateVsCodeState.test.ts` |

## CONVENTIONS
- `constants.ts` is a deliberate barrel re-exporting `server/src/constants.js` layout keys - VS Code code imports layout persistence constants from here, never straight from `server/src/constants.js`.
- Folder->Area mappings live in `~/.pixel-agents/config.json` (`vscode.areaMappings`), not globalState.
- Consent: call the shared `applyConsentChoice` with VS Code `ConsentEffects`; only reporting/error presentation is host-specific.
- `dist/extension.js` bundle: `external: ['vscode']` only - everything else is inlined (VSIX must carry no `node_modules/`, see `scripts/verify-vsix-package.mjs`).
- `node esbuild.js --watch` rebuilds ONLY `extension.ts`; hooks, CLI, uninstall and the webview need their own build.
- Manual hook testing against a running Extension Development Host: `server/manual-hook-events.http` (port + token from `~/.pixel-agents/server.json`).

## ANTI-PATTERNS
- Importing this directory from `server/` or `server/src/cli.ts`.
- Reimplementing consent ordering or runtime lifecycle here - extend `server/` instead so standalone gets it too.
- Persisting `hooksEnabled` before install/uninstall settles and `areHooksInstalled()` agrees.
- Clearing a legacy globalState key before its file write was read back (verify-before-clear).
- Verifying changes here with VS Code e2e from a subagent; use typecheck + `server/__tests__` + standalone specs.
