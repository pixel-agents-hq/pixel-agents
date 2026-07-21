# Pixel Agents e2e tests

Playwright end-to-end tests for the VS Code extension and the standalone `npx pixel-agents` server. This README is the single source of truth for what's e2e-tested, what's not, and how to run the suite.

## What this suite covers

Behavioral overview by area. Each area corresponds to a `test.describe` block in the spec files, an `@area:` tag on each test title, and an Allure `epic` label.

### Spawn paths (`@area:spawn`)

Agents being created and adopted. Covers internal terminals launched by clicking `+ Agent`, external Claude sessions adopted by the hook server or the JSONL scanner, basic Task subagent appearance/despawn, and lead+teammate routing for inline and tmux team modes.

### Lifecycle regressions (`@area:lifecycle`)

Edge cases that historically caused agent-character desync: `/clear`, `--resume`, X-button close, dismissal cooldown, parallel sub-agents, teammate add/remove, rapid `/clear` followed by a new tool, late resume after stale cleanup.

### Cross-cutting checks (`@area:cross-cutting`)

Invariants that should hold across every spawn path: tool status text matches the active tool name, sound chimes fire on the right events, restored agents skip the matrix spawn animation, hook installer preserves third-party hooks, settings persist across webview reload, sub-agent permission timer fires, layout editor enter/paint/save/exit smoke.

### Teams routing (`@area:teams`)

Lead and teammate tool routing in both inline and tmux team modes, internal and external.

### Hooks-off matrix (`@area:matrix`)

Every spawn permutation (internal vs external origin × basic vs inline-teammate vs tmux-teammate mode) re-verified against the heuristic JSONL-polling path with the hook server disabled. Confirms the polling-based detection produces the same agent state as the hook-driven path.

### Standalone server (`@area:standalone`)

The `npx pixel-agents` CLI path: hook-driven lifecycle propagates from the local server into the browser SPA via the single `/ws` WebSocket endpoint.

### Pet system (`@area:pets`)

The animated pets feature, which has no hook dependency. Pet sprites load and the `petSpritesLoaded` broadcast arrives with manifest display names; placing a pet from the Pets-tab carousel toggles it on/off and persists across a panel reload via `~/.pixel-agents/layout.json`; clicking a pet shows a heart bubble that auto-dismisses and dismisses again on re-click. Pets render only on the canvas, so live state is read through the `getPets` / `petClick` e2e test hooks. FSM internals, pathfinding, FOLLOW, z-sort, and legacy-layout migration are covered by webview unit tests, not e2e.

## What's NOT covered (gaps + deferred)

Scenarios that exist as product behavior but are not in the automated suite. PRs that close a gap should remove the corresponding row.

| Scenario                                                                                 | Why not automated                                                                                                                            | Tracked                      |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Multi-window `layout.json` cross-sync                                                    | Needs two VS Code instances simultaneously; fixture work                                                                                     | none                         |
| External asset directory add/remove via Settings                                         | Needs bundled test asset packs                                                                                                               | none                         |
| Bypass-permissions startup flag                                                          | Security-sensitive; manual review path                                                                                                       | none                         |
| Workspace folder add/remove mid-session                                                  | Edge case; infra-heavy                                                                                                                       | none                         |
| Heuristic-timer cancellation after **internal-terminal** agent close                     | VS Code terminal panel collapse races the canvas click on the X overlay; covered via the external-agent variant which dodges the layout race | external variant in suite    |
| Producer/viewer relay scenarios (multi-viewer replay, producer reconnect reconciliation) | Producer endpoint not yet built                                                                                                              | `feat/producer-viewer-split` |

## Pre-release manual smoke (~30 min)

CI green on this suite is the safety net for behavioral regressions. The checks below are what e2e can't meaningfully assert on (visual polish, real-Claude integration, cross-process behaviors). Run them before tagging a Marketplace release — not on every PR.

**Visual + interactive polish** (after any change touching `renderer.ts`, `spriteCache.ts`, `colorize.ts`, `*.tsx`, CSS, or `editorActions.ts`):

- Pan around the office with middle-mouse drag — characters z-sort correctly against same-row chairs and lower-row desks, no flicker.
- Spawn 3+ agents — matrix spawn animation renders cleanly, characters move smoothly between seats.
- Open the Layout editor — paint floor with HSBC sliders, place + rotate (R) furniture, toggle on/off (T) state, drag-to-move in SELECT, multi-stage Esc unwinds correctly.
- Hover and click characters — overlay text positioning is correct, selection outline crisp, click on a seat reassigns.

**Real Claude Code integration** (mock-claude is a fixture; real Claude's JSONL has edge cases the mock doesn't):

- Launch the Extension Development Host (F5), click + Agent, ask Claude to do a few tool-heavy turns and a permission-requiring tool. Watch for character desync, missing animations, stuck permission bubbles.
- Use a session with a large pasted image (multi-MB base64 user message) — confirm the "Possible format issue" warning doesn't false-fire and tool tracking still works.
- Test with one MCP server installed — confirm `mcp_progress` records don't break tool status.

**`npx pixel-agents` standalone** (e2e covers Chrome via Playwright; verify other browsers + real workflow):

- `node dist/cli.js` (or `npx pixel-agents` after publish), open `http://localhost:3100` in Firefox AND Safari, run a real Claude session in a terminal — confirm characters appear and animate via WebSocket.
- Refresh the browser mid-session — WebSocketTransport reconnects, agents reappear from server state.

**Cross-window sync** (rarely covered by CI, easy to break):

- Open two VS Code windows. Edit the layout in one (paint a tile, save). Within ~2 s the other window picks it up.

**First-run experience** (before publishing):

- Delete `~/.pixel-agents/` entirely. Launch the extension fresh — default layout loads, first-run tooltip appears, no console errors, hooks auto-install on first agent spawn.

**Platform sanity** (CI hosts ≠ your machine):

- On the OS you primarily develop on, run a normal session for ~5 minutes — confirm no surprise CPU spikes, no leaked file watchers, panel reload doesn't lose state.

Skip the F5 matrix walk-through that used to take hours — the e2e suite covers it. Hand-driven testing now exists only to catch what automated assertions structurally can't see.

## Running

```bash
cd pixel-agents
npm run compile && npm run e2e               # full suite (~10 min)

npm run e2e -- --grep "@area:spawn"          # filter by area tag
npm run e2e -- --grep "@area:cross-cutting"
npm run e2e -- --headed                      # watch chromium for standalone test

npm run e2e:inventory                        # regenerate the inventory section below
npm run test:report                          # build the Allure dashboard from latest run
npm run test:report:open                     # serve + open the Allure dashboard in a browser
```

## Mocking model & rules

E2E tests drive Pixel Agents through a Claude-like **process boundary**, not by poking internals. The mocked `claude` (`e2e/fixtures/mock-claude` → `mock-claude-runner.cjs`) behaves like the real CLI for the parts Pixel Agents observes: it spawns as a process, creates its own append-only JSONL transcripts, and executes the installed hook script under `~/.pixel-agents/hooks` — the same path the real CLI uses. The builder API itself (`claudeScenario(...)`, `.at()`, `.appendJsonl()`, `.emitHook()`, `.holdOpenFor()`) is documented in CONTRIBUTING.md → "Mock claude".

Rules for a correct test:

- **Drive behavior through a scenario, not by hand.** Define timed actions with the `claudeScenario(...)` builder and let the mock perform them. Don't hand-write transcript files or hand-fire hooks inside a terminal-driven test body.
- **Transcripts are append-only.** Existing JSONL lines are never mutated in place; new records appear later in the stream. Scenarios model this with timed `.appendJsonl(...)` steps.
- **Assert only on Playwright-visible outcomes** — agent overlays, character state, sound hooks — never on the mock's internals. The mock never decides pass/fail.
- **Standalone is the one exception.** `standalone/hooks.spec.ts` has no VS Code terminal to host a mocked `claude`, so it POSTs to the server's hook endpoint directly via `sendHookEvent`. That is correct _only_ for the standalone-server path; every terminal-driven test must use the scenario builder.

## What to read before adding a test

- `pixel-agents/CLAUDE.md` — architecture and message protocol
- `pixel-agents/e2e/fixtures/pixel-agents.ts` — fixture lifecycle
- `pixel-agents/e2e/helpers/` — every helper, especially `hooks.ts`, `mock-claude.ts`, `office.ts`, `webview.ts`

When you add a new test:

- Pick a `test.describe` block that matches an existing `@area:` tag, OR add a new area to the "What this suite covers" section above and pick a tag.
- Add `@area:<tag>` to the test title.
- Add Allure `epic` / `feature` / `story` labels matching the area.
- Run `npm run e2e:inventory` and commit the regenerated section.

When you remove a test:

- Run `npm run e2e:inventory` so the inventory drops it.
- If the scenario it tested is now manual or deferred, add a row to "What's NOT covered".

## Narration

Every VS Code run video is narrated. The narrator writes one yellow `[test]` line per
action taken and per assertion verified to a per-test log, and several surfaces
display it by simply tailing that log:

```
narrate.step()/check()  ──►  <tmpHome>/.claude-mock/test-narration.log     (yellow [test])
external mock stdout     ──►  <tmpHome>/.claude-mock/external-narration.log (magenta [external·tag])

Surface A — the "e2e monitor" terminal: opened by the fixture after VS Code
            finishes restoring the review layout (openMonitorTerminal). Tails
            BOTH logs, so even a test with no agents has a narrated surface
            from its first action.
Surface B — every mock-claude terminal tab: the wrapper backgrounds a headerless
            tail of both logs into its own stdout, interleaved with the runner's
            cyan [mock-claude] lines. Whichever tab has focus, the full story
            shows. Because the tail starts at byte 0, a tab opened mid-test
            replays the whole story so far.
```

Standalone recordings are deliberately raw browser artifacts. Their fixture has
no VS Code terminal or narration surface, so the eight standalone videos are
outside this narration contract.

Usage: the `pixelAgents` fixture exposes a `narrator` on its payload — tests call
`narrator.step('…')` before an action and `narrator.check('…')` after an
assertion resolves. Shared helpers narrate universal moments (spawning/closing an
agent) via the module-level `narrate` in `helpers/test-narration.ts`.

**Cosmetic-only contract (never violate):** Pixel Agents never reads terminal
output — its inputs are JSONL transcripts and hook POSTs — so narration cannot
change what a test exercises. Narration must **never carry an assertion, gate
logic, or affect timing**. Deleting every `step`/`check` call must leave all
tests passing. Never call the narrator from inside a browser-context callback
(`frame.waitForFunction`/`evaluate`/`.poll`) — it is Node-side only. Never add a
`waitForTimeout` for narration's sake. After the test body is complete, the
fixture may wait for the final narration marker to render before closing the
recorded window; that teardown-only synchronization cannot gate test behavior.

## Test inventory

This section is auto-generated. Do not edit between the markers; CI fails on drift.

<!-- BEGIN:E2E-INVENTORY -->

74 tests total. Generated by `scripts/generate-e2e-inventory.mjs`. Re-run after adding or removing tests.

### `@area:spawn` (2 tests)

- `e2e/claude/hooks-on/basic.spec.ts:24` — internal terminal spawns agent and Task subagent appears then despawns (Hooks ON / spawn paths)
- `e2e/claude/hooks-on/basic.spec.ts:89` — external Claude session adopted via hook confirmation lifecycle (Hooks ON / spawn paths)

### `@area:lifecycle` (22 tests)

- `e2e/claude/hooks-off/lifecycle.spec.ts:59` — /clear on internal agent reassigns the same character via JSONL polling (Hooks OFF / lifecycle)
- `e2e/claude/hooks-off/lifecycle.spec.ts:137` — /resume at startup reassigns the same agent via JSONL polling (Hooks OFF / lifecycle)
- `e2e/claude/hooks-off/lifecycle.spec.ts:183` — /clear edge case with a sibling agent in the same projectDir via JSONL polling (Hooks OFF / lifecycle)
- `e2e/claude/hooks-off/lifecycle.spec.ts:268` — /clear retains its character after the terminal editor moves (Hooks OFF / lifecycle)
- `e2e/claude/hooks-off/lifecycle.spec.ts:346` — heuristic late --resume after stale cleanup prevents zombie agents (Hooks OFF / lifecycle)
- `e2e/claude/hooks-off/lifecycle.spec.ts:410` — three parallel Task subagents in one turn render distinct sub-characters via polling (Hooks OFF / lifecycle)
- `e2e/claude/hooks-off/lifecycle.spec.ts:478` — inline teammate removed from team config disappears within one second via polling (Hooks OFF / lifecycle)
- `e2e/claude/hooks-off/lifecycle.spec.ts:540` — rapid /clear then new tool within 500ms lands on the reassigned agent via polling (Hooks OFF / lifecycle)
- `e2e/claude/hooks-off/lifecycle.spec.ts:601` — close via X prevents re-adoption of old JSONL during dismissal cooldown via polling (Hooks OFF / lifecycle)
- `e2e/claude/hooks-off/lifecycle.spec.ts:675` — external basic subagent with run_in_background but no teamName routes to basic path (Hooks OFF / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:81` — /clear on internal agent reassigns the same character to the new JSONL (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:143` — /resume reassigns the same agent within the grace window (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:210` — /clear edge case with a sibling agent in the same projectDir (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:301` — --resume after the grace window expires cleans up the old agent (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:374` — three parallel Task subagents in one turn render distinct sub-characters (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:443` — inline teammate removed from team config disappears within one second (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:505` — lead SessionEnd cascade-removes active inline teammates (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:591` — external basic subagent with run_in_background routes to basic path (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:660` — lead permission_prompt routes bubble to teammate not lead when teammates exist (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:749` — TeammateIdle marks only the targeted teammate done and leaves lead unchanged (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:863` — rapid /clear then new tool within 500ms lands on the reassigned agent (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:921` — close via X prevents re-adoption of old JSONL during dismissal cooldown (Hooks ON / lifecycle)

### `@area:cross-cutting` (13 tests)

- `e2e/claude/hooks-off/lifecycle.spec.ts:735` — agentToolsClear fires at turn end via turn_duration JSONL record (Hooks OFF / lifecycle)
- `e2e/claude/hooks-off/lifecycle.spec.ts:800` — heuristic permission timer is cancelled when an agent is closed via overlay (Hooks OFF / lifecycle)
- `e2e/claude/hooks-off/lifecycle.spec.ts:879` — sub-agent permission bubble fires on stalled non-exempt sub-tool via heuristic timer (Hooks OFF / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:1020` — done sound chime fires on agentStatus waiting (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:1113` — restored agents skip the matrix spawn animation (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:1197` — tool status text matches every PreToolUse tool name (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:1292` — permission sound chime fires on agentToolPermission (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:1411` — pixel-agents hook is installed in settings.json on extension startup (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:1433` — hook install and uninstall round-trip via the Settings toggle (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:1487` — permission bubble auto-clears when a fresh PreToolUse arrives (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:1561` — settings toggles persist across a webview reload (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:1603` — layout editor enter paint save persist and exit round-trip (Hooks ON / lifecycle)
- `e2e/claude/hooks-on/lifecycle.spec.ts:1684` — hook uninstall preserves a pre-existing third-party hook entry (Hooks ON / lifecycle)

### `@area:teams` (4 tests)

- `e2e/claude/hooks-on/teams.spec.ts:55` — internal terminal lead with inline teammate routes tools to teammate (Hooks ON / teams)
- `e2e/claude/hooks-on/teams.spec.ts:112` — internal terminal lead with tmux teammate routes tools to teammate (Hooks ON / teams)
- `e2e/claude/hooks-on/teams.spec.ts:186` — external session lead with inline teammate routes tools to teammate (Hooks ON / teams)
- `e2e/claude/hooks-on/teams.spec.ts:265` — external session lead with tmux teammate routes tools to teammate (Hooks ON / teams)

### `@area:matrix` (6 tests)

- `e2e/claude/hooks-off/matrix.spec.ts:49` — internal basic spawn adopted via JSONL polling (Hooks OFF / matrix)
- `e2e/claude/hooks-off/matrix.spec.ts:87` — internal inline teammate adopted via JSONL polling (Hooks OFF / matrix)
- `e2e/claude/hooks-off/matrix.spec.ts:143` — internal tmux teammate adopted via JSONL polling (Hooks OFF / matrix)
- `e2e/claude/hooks-off/matrix.spec.ts:208` — external basic spawn adopted via JSONL polling (Hooks OFF / matrix)
- `e2e/claude/hooks-off/matrix.spec.ts:253` — external inline teammate adopted via JSONL polling (Hooks OFF / matrix)
- `e2e/claude/hooks-off/matrix.spec.ts:312` — external tmux teammate adopted via JSONL polling (Hooks OFF / matrix)

### `@area:standalone` (8 tests)

- `e2e/standalone/hooks.spec.ts:10` — propagates hook-driven lifecycle into the browser UI (Standalone / hooks)
- `e2e/standalone/multi-server-hooks.spec.ts:31` — extension and standalone both stay hook-driven without cross-contamination (Standalone / multi-server hooks)
- `e2e/standalone/ui.spec.ts:27` — closeAgent despawns the character (Standalone / UI)
- `e2e/standalone/ui.spec.ts:61` — Debug View renders JSONL diagnostics in standalone (Standalone / UI)
- `e2e/standalone/ui.spec.ts:95` — adding an external asset directory triggers a live asset reload (Standalone / UI)
- `e2e/standalone/ui.spec.ts:125` — browser Export Layout downloads the layout file (Standalone / UI)
- `e2e/standalone/ui.spec.ts:140` — browser Import Layout applies the chosen file (Standalone / UI)
- `e2e/standalone/ui.spec.ts:175` — ConnectionIndicator appears when the WebSocket connection drops (Standalone / UI)

### `@area:areas` (8 tests)

- `e2e/claude/hooks-off/areas-multiroot.spec.ts:49` — painting an area labels tiles in the layout (Areas (multi-root))
- `e2e/claude/hooks-off/areas-multiroot.spec.ts:77` — areas can be added and removed (Areas (multi-root))
- `e2e/claude/hooks-off/areas-multiroot.spec.ts:110` — a folder can be mapped to an area and the mapping persists (Areas (multi-root))
- `e2e/claude/hooks-off/areas-multiroot.spec.ts:169` — an agent for the MAPPED folder takes a seat inside its area (Areas (multi-root) › seat preference (alpha → Engineering))
- `e2e/claude/hooks-off/areas-multiroot.spec.ts:200` — an agent for an UNMAPPED folder is not forced into the area (Areas (multi-root) › seat preference (alpha → Engineering))
- `e2e/claude/hooks-off/areas.spec.ts:39` — seeded areas + areaTiles load and showAreas is effective (Areas (single-folder) › seeded area data + show-areas state)
- `e2e/claude/hooks-off/areas.spec.ts:71` — the Areas tool button is hidden without workspace folders (Areas (single-folder))
- `e2e/claude/hooks-off/areas.spec.ts:90` — the Areas tool button is visible with a seeded areas layout (Areas (single-folder) › seeded areas layout (positive gate))

### `@area:carpet` (8 tests)

- `e2e/claude/hooks-off/carpet.spec.ts:50` — carpet sprites load + broadcast, and the Carpet category renders variants (Carpet)
- `e2e/claude/hooks-off/carpet.spec.ts:71` — painting a tile records it in the carpet layer (Carpet)
- `e2e/claude/hooks-off/carpet.spec.ts:88` — autotiling: the junction case reflects neighboring carpet tiles (Carpet)
- `e2e/claude/hooks-off/carpet.spec.ts:129` — erasing removes a carpet tile (Carpet)
- `e2e/claude/hooks-off/carpet.spec.ts:152` — the carpet eyedropper copies a tile’s variant (Carpet)
- `e2e/claude/hooks-off/carpet.spec.ts:180` — a carpet stroke is a single undo entry (Carpet)
- `e2e/claude/hooks-off/carpet.spec.ts:201` — carpet tiles persist across a save + panel reload (Carpet)
- `e2e/claude/hooks-off/carpet.spec.ts:297` — a seeded carpet coexists with furniture on the same tile (Carpet surface placement (seeded))

### `@area:pets` (3 tests)

- `e2e/claude/hooks-off/pets.spec.ts:90` — pet sprites load, broadcast, and expose manifest names in the editor (Pets)
- `e2e/claude/hooks-off/pets.spec.ts:117` — placing a pet toggles it on/off and persists across a panel reload (Pets)
- `e2e/claude/hooks-off/pets.spec.ts:202` — clicking a pet shows a heart bubble that auto-dismisses and dismisses on re-click (Pets)

<!-- END:E2E-INVENTORY -->

## Coverage philosophy

We do not measure e2e via code coverage (too noisy, doesn't map to user-observable scenarios). Coverage is tracked by:

1. **The inventory section above** — every test in the suite with its area tag and file:line.
2. **The "What's NOT covered" gap list** — deliberately maintained; closing a gap removes the corresponding row.
3. **Allure dashboard** — `epic` / `feature` / `story` labels group tests by area without needing this file. Run `npm run test:report` after a suite run, then open `allure-report/allure/index.html` → Behaviors view.
