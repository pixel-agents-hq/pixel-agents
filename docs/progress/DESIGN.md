# Stage track + done-today strip: design

Status: approved 2026-10-17 · Branch: `remote-ingest` · Layout: mockup A (a bookshelf of trophies comes later)

## What the user sees

- **Stage track** on each character's label: four pips, `EXPLORE · BUILD · TEST · SHIP`.
  Phases reached in this cycle are green, the current one is yellow, and the rest are dim.
- **Waiting badge** on the label while a session waits on the user: `⏳ waiting on you 14m`.
  It turns yellow at 5 min and red at 15 min.
- **Daily strip** along the bottom: `TODAY 🏆 3 PRs 📦 7 pushes ✏️ 42 files ⌨️ 118 cmds ⏱ 5.2 h`, followed by the
  newest PR trophies (title + repo; a click opens the URL). Phones get a compact one-line version.

## Rules (server side, so every viewer sees the same numbers)

| Phase   | Tool                                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| explore | Read, Grep, Glob, WebSearch, WebFetch, LS                                                                                                                                                              |
| build   | Edit, Write, MultiEdit, NotebookEdit                                                                                                                                                                   |
| test    | Bash/PowerShell whose `command` looks like a test/check/build (`test`, `vitest`, `jest`, `pytest`, `mocha`, `tsc`, `lint`, `eslint`, `build`, `playwright`, `cargo test`, `go test`, `npm run check…`) |
| ship    | Bash/PowerShell `git commit`, `git push`, `gh pr create`, `gh pr merge`                                                                                                                                |

- Other tools leave the phase unchanged.
- **phase** = the phase of the most recent classified tool. **reached** = phases first reached in this cycle, in order.
- A **cycle resets** on the first classified tool that comes 30 min or more after the previous one, or right after a ship tool.
- **waitingSince**: when the agent's status becomes `waiting`. Cleared when it becomes `active`.

**Daily totals** cover the local day, are kept in `~/.pixel-agents/daily/YYYY-MM-DD.json` (atomic write, debounced),
and are reloaded on start:

- `commandsRun`: +1 per Bash/PowerShell tool start.
- `filesEdited`: unique `file_path`/`notebook_path` across Edit/Write/MultiEdit/NotebookEdit starts.
- `pushes`: +1 per successful `git push` tool end (PostToolUse, not PostToolUseFailure), counted per repo.
- `prs`: one per successful `gh pr create`.
  - **title**: from `--title`/`-t` in the command, else `PR`.
  - **url**: the first `https://github.com/<o>/<r>/pull/<n>` in the tool response, or the relay's `pr_url` for remote sessions.
  - **repo**: `<o>/<r>` from the url, else the agent's directoryName.
  - Duplicate urls are ignored.
- `activeMs`: summed time from each `active` to the next `waiting`.

`repo` for pushes is the agent's `directoryName`, or `unknown`.

## Protocol (`core/asyncapi.yaml`, already generated)

- `agentProgress { id, phase?, reached[], waitingSince? }`
- `dailyStats { date, prs[{title, repo, url?, at}], pushes[{repo, count}], filesEdited, commandsRun, activeMs }`

Both are broadcast on change. On connect, the server sends `dailyStats` and an `agentProgress` for every agent.

## Build

- **Server** (`server/src/progress/`):
  - `phase.ts`: pure. `classifyTool(toolName, input)`, `isTestCommand`, `isShipCommand`, `isPushCommand`, `isPrCreateCommand`, `prTitleFromCommand`, `findPrUrl(text)`.
  - `progressTracker.ts`: owned by AgentRuntime.
  - **Inputs**:
    - From HookEventHandler: tool start and tool end, with the raw event (`tool_input`, `tool_response`, `pr_url`, failure flag).
    - From the store's `agentStatus` broadcasts: active and waiting.
    - From `agentRemoved`.
    - Agents without hooks feed tool starts from transcriptParser, and only while `hookDelivered` is false.
  - **Output**: broadcasts through the store, plus a connect-time snapshot sent alongside the existing per-agent activity resend.
- **Relay**: before dropping `tool_response` on a successful `gh pr create`, copy the first GitHub PR url into `pr_url`.
- **Web UI**:
  - State maps in `useExtensionMessages`.
  - Pips and badge in `ToolOverlay`.
  - New `DailyStrip` component (desktop + mobile).
  - Pure helpers in `webview-ui/src/progress/progressFormat.ts`: `waitLevel` (`none` <5 min, `yellow` <15 min, `red`), `formatWait`, `formatHours`.

## Tasks

- [x] Protocol: AgentProgress, DailyStats, WorkPhase, DailyPr, DailyPush
- [x] Server: phase rules + tracker + persistence + wiring + connect snapshot (164 tests)
- [x] Relay: `pr_url` (3 tests)
- [x] Web UI: label pips + waiting badge + DailyStrip + helpers (18 tests)

Implementation notes:

- Commit → push → PR in a row is one ship step; the next non-ship tool starts a new cycle.
- Bare runtimes (no StateAdapter, e.g. tests) keep totals in memory.
- An active span still open when an agent is removed is not counted, so an expired remote agent doesn't add 3 h.
- Agents without hooks (transcript only) contribute tool starts and `pr-link` PRs, but not pushes.
- [ ] Integrate: build, full checks, live run through the board, screenshots (TV + phone)
