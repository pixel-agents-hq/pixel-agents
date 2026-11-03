# e2e/ - Playwright suite (VS Code Electron + standalone browser)

Score 13 (45 files, 3 subdirs, own Playwright/TS config, fan-in helpers up to 18 importers). Normative rules: `README.md` -> "Mocking model & rules" - read before writing a spec.

## STRUCTURE
```
e2e/
├── fixtures/   # pixel-agents.ts (VS Code), standalone.ts (CLI), mock-claude{,.cmd} -> mock-claude-runner.cjs
├── helpers/    # webview.ts (18 importers), mock-claude.ts, office.ts, hooks.ts, editor.ts, team.ts, launch.ts, standalone.ts ...
└── tests/      # claude/hooks-on, claude/hooks-off (VS Code), standalone/ (headless)
```

## WHERE TO LOOK
| Task | Location |
|------|----------|
| Drive an agent | `helpers/mock-claude.ts` `claudeScenario()`, `arrangeNextClaudeInvocation`, `spawnExternalClaudeScenario` |
| Hook payload builders | `helpers/hooks.ts` |
| Transcript/team record builders | `helpers/team.ts`, `helpers/lifecycle.ts` |
| Overlay assertions | `helpers/office.ts` (`Frame \| Page`: same helper both surfaces) |
| Canvas state / editor actions | `helpers/editor.ts` via `window.__pixelAgentsTestHooks` |
| Seeded layout/config | `helpers/layout-seed.ts` (`SEED_LAYOUT_REVISION = 9999` beats the default-reset gate) |
| Standalone server + `/ws` recorder | `helpers/standalone.ts` |

## CONVENTIONS
- Every test title ends with `@area:<tag>`; add/rename/remove a test -> `npm run e2e:inventory` (CI diffs `README.md`).
- Seed before activation via `test.use({ seedLayout, seedConfig, seedClaudeSettings, workspaceFolders, seedHooksConsent, standaloneOptions })`. Fixtures pre-seed consent granted + `alwaysShowLabels`.
- Config: `workers: 1`, `retries: 1`, `timeout: 120_000`, `fullyParallel: true` (even shard split).
- VS Code webview reload = close + reopen the bottom panel (`closeBottomPanel` + `openPixelAgentsPanel`).
- Standalone PTY specs skip win32 at `describe` scope (fixture spawns before the body).
- Narration (`narrator.step/check`) is cosmetic only.

## ANTI-PATTERNS
- Running `tests/claude/**` without user approval, mid-implementation, or from a subagent (steals focus).
- Hand-writing JSONL or firing hooks in terminal-driven tests; only standalone specs with no terminal may `sendHookEvent`.
- Mutating existing transcript lines; asserting on mock internals.
- `window.location.reload()` in a VS Code webview; `setOffline(true)` to drop the WS (use `standalone.stop()`).
- Immediate negative overlay assertions (vacuous) - settle or `expectStays`; polling transient `count === 0` - assert on agent ids.
- `[title="<path>"]` selectors (Windows backslashes) - use `getByTitle(path, { exact: true })`.
- Synthesizing the server token from `server.json` - navigate to the printed URL.
- Skipping `endStroke(frame)` between undo strokes; heuristic permission-bubble waits under 10 s.
- Toggling the panel through the Command Palette (fuzzy hits "Toggle Maximized Panel").
