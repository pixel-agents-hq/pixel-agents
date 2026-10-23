# Living office: design

Status: approved 2026-10-17 · Branch: `remote-ingest`

Every room means something: a character walks to the zone that matches what its
session is doing, so the board reads at a glance. Behaviour is client-side
animation driven by signals the board already has. The server only adds what it
alone knows.

## Zones

Zones are layout **Areas** (`areas` + `areaTiles` in the layout JSON, an existing
feature) with reserved labels:

| Label      | Room                       | Spots                             |
| ---------- | -------------------------- | --------------------------------- |
| `Entrance` | Reception by the main door | the door tile (spawn/despawn)     |
| `Smoke`    | Balcony off the lounge     | standing spots around the ashtray |
| `Lounge`   | Sofas                      | sofa seats                        |
| `Meeting`  | Meeting room               | table chairs                      |
| `Server`   | Server room                | standing spots facing the racks   |
| `Cafe`     | Café                       | counter and bistro seats          |

A layout without a zone simply skips that behaviour, so the default layout still works.

## Rules (first match wins)

| Signal                                                                     | Destination                              | Effect                                                                                                 |
| -------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| sleeping (`agentSleep`)                                                    | Lounge seat                              | dimmed, 💤                                                                                             |
| needs permission, or running `AskUserQuestion`                             | Meeting chair                            |                                                                                                        |
| current tool is a test/build command (phase `test` with a live shell tool) | Server spot                              | rack LEDs blink                                                                                        |
| active                                                                     | own desk seat                            | name plate shows the repo                                                                              |
| turn ended, waiting on the user                                            | Smoke spot                               | cigarette + rising puffs; back to the desk on `active`                                                 |
| short gap between tools, sometimes                                         | Café counter, then back                  | coffee cup                                                                                             |
| `agentCreated`                                                             | spawn at Entrance door, walk to the desk |                                                                                                        |
| `agentClosed`                                                              | walk to the Entrance door, then despawn  |                                                                                                        |
| `dailyStats` gains a push or PR                                            | bell rings at the desk                   | confetti; a trophy appears on the trophy wall (cups = PRs, boxes = pushes, at most one per shelf slot) |

**Hysteresis**: keep a destination for at least 8 s, so fast tool bursts don't make a
character pace back and forth. Sub-agents follow their parent's zone, except
`active`, where they take the nearest free desk.

## Ambience

- **Office cat**: one built-in pet wanders the office.
- **Windows**: wall windows tint with the local time: day, dusk, night.
- **Lights**: at night the canvas dims a little. A room with nobody in it dims further.
- **Name plates**: a small plate on each occupied desk with the repo name. A repo tends to
  keep the same desk, through the existing Directory → Area seat bias.

## Art (sprite pack)

`remote/office-pack/` is an external furniture pack in the same format as
`dist/assets/furniture/*` (16 px grid, manifest + PNG), drawn to match the default palette:

- ASHTRAY_STAND
- SERVER_RACK (2 LED frames)
- RECEPTION_DESK
- BELL
- TROPHY_CUP (gold, silver, bronze)
- TROPHY_BOX
- COFFEE_MACHINE
- WATER_COOLER
- WINDOW (day, dusk, night)
- NAME_PLATE
- BALCONY_RAILING
- stone floor tile

Effects drawn by the renderer rather than shipped as furniture: smoke puffs, confetti, cigarette.

## Additions (user decisions, 2026-10-17)

- **Labels: task title + repo**, e.g. `Draft review by email · hobbyfi-blog`.
  - The title comes from the session transcript's `ai-title` records (newest wins), read by the server and sent with the agent.
  - Remote (Mac) sessions have no transcript here, so they keep `💻 Mac · repo`.
- **Sound: bell + needs-you chime.**
  - A bell when a push or PR lands.
  - The existing chime on a permission request or a turn ending.
  - Browsers need one click on the tab to unlock audio. The board shows a small "🔈 click to enable sound" hint until then.
- **Phone alerts (ntfy)**:
  - The server POSTs once per wait to `https://ntfy.sh/<random topic>` when an agent has waited on the user for 15 min.
  - Body: `⏳ <title> · <repo> is waiting on you (15m)`. Nothing else: no commands, no paths.
  - The topic is stored in `~/.pixel-agents/alerts.json` and is off when absent. The user subscribes in the ntfy app.
- **Background agents → compact "remote workers"**:
  - Background/headless sessions get small tiles in a corner panel (status dot + title + repo) instead of full characters.
  - Detection: the session list's `kind` is not `interactive`. Hook-only local sessions that never appear in the list within 30 s are treated as headless.
  - Remote sessions are always full characters.
- **Crowding**:
  - When Smoke has no free spot, extra waiters go to the Cafe.
  - When no desk is free, extra workers take Cafe/Lounge seats.
  - Sessions shorter than ~20 s skip the walk-in/walk-out animation.

## Phases (each shown to the user before the next)

- **A. Living office**: zones in the layout, destination engine, entrance walk in/out,
  smoke, lounge, meeting, server. Also task-title labels, remote-worker tiles for background
  agents, and ntfy phone alerts.
- **M. Manager + task log** (approved 2026-10-17, built right after A):
  - **Task log (server, `server/src/tasks/`)**:
    - A task is a session's title period. A new or changed `ai-title` closes the previous task as done and opens a new one.
    - Before a title arrives the task is `Untitled · <repo>`; it is renamed, not replaced, when the first title comes.
    - A remote session with no transcript is one task per session, `💻 <source> · <repo>`.
    - Status: `in_progress` (active), `waiting` (waiting on the user), `done` (title changed, or the session ended or expired).
    - Fields: id, title, repo, machine (local or source label), sessionId, startedAt, endedAt, status, PRs[], pushes, filesEdited, commands, activeMs.
    - Stats are attributed to the task live at the time, reusing ProgressTracker's per-event counting.
    - Stored in `~/.pixel-agents/tasks/YYYY-MM-DD.json` (atomic writes) and kept forever.
    - Sessions whose cwd is the manager's working dir are excluded.
    - Protocol: a `tasksSnapshot` (today) on connect, `taskUpdated` on change, and a `requestTasks {date}` request that read-only clients may send (viewing only).
  - **Reports**:
    - Generated daily at 19:00 local, or from "Write report now" (privileged clients only; it uses the subscription).
    - The server builds a compact JSON of the day's tasks and runs `claude -p --tools "" --no-session-persistence --output-format text` (execFile, no shell, cwd `~/.pixel-agents/manager`, timeout 120 s). The prompt asks for a short manager-style report:
      - done today
      - still open
      - waiting on Ansh
      - PRs shipped
      - stuck or failing items
      - one line of advice
    - `--bare` is not used: it skips subscription auth.
    - On failure, a deterministic template report is written instead.
    - Saved to `~/.pixel-agents/reports/YYYY-MM-DD.json` (markdown, generatedAt, aiWritten).
    - Pushed via ntfy: `📋 Daily report: N done, N open, N waiting`.
    - Protocol: `reportReady {date}`, and `requestReport {date}` (read-only allowed).
  - **Office**:
    - A private **"Ansh" room** (zone label `Ansh`) with the user's chibi at a desk and a door sign.
    - Permission requests knock on its door (replacing Meeting for permissions; questions still go to Meeting).
    - A **Manager** NPC with a clipboard at a desk outside the room. At report time the Manager walks into Ansh's office and back.
    - Clicking or tapping the Manager opens the **Tasks board**:
      - kanban columns In progress / Waiting on you / Done
      - a date picker for history
      - a Report tab with the rendered markdown
      - "Write report now" for privileged clients
- **B. Celebrations**: bell (with sound), confetti, trophies on the trophy wall.
- **C. Ambience**: café coffee runs, cat, day/night windows and lights, name plates.
- **D. Useful signals** (queued 2026-10-17):
  - **Trouble**:
    - Each failed tool (PostToolUseFailure, or a shell command that exits non-zero) puts a small 🔥 on the desk.
    - 3 failures in a row turn on a red alarm lamp ("stuck?").
    - Cleared on a success.
  - **Loop detector**: the same tool and input repeated, or no new file/phase progress for N minutes while active, shows 🌀 "going in circles?".
  - **Ansh's office**: moved into phase M.
  - **Tap-for-timeline**: tapping or clicking a character opens its last ~10 actions, today's PRs and pushes, and its time worked. The server keeps a small ring buffer per agent.
  - **Spend/token meter**:
    - Today's tokens, read from transcript usage records, on the TODAY strip.
    - An estimated $ figure from a pricing table that is checked against current Claude pricing at build time, never from memory, and labelled "est.".
- **E. Fun** (queued 2026-10-17):
  - **Festival decorations by local date**: Diwali lights, Holi colours, New Year.
  - **Rituals**: a 10:00 standup where awake characters gather in Meeting for 30 s; at 19:00 a "today: N PRs 🎉" banner and the lights dim.
  - **Whiteboard / library / crowns**: plan mode → draw at the whiteboard; WebSearch/WebFetch → read at a bookshelf; team leads wear a crown.
  - **Week wall**: past days from ~/.pixel-agents/daily/ as a wall calendar with streaks.
  - **Weather**: real weather in the windows, for a city guessed once from the PC's IP and cached.
  - **Lo-fi radio**: a toggle in the lounge.
- **F. Office life** (queued 2026-10-17):
  - **Smart pets** (built-in pets `gitcat` and `claudio`):
    - **Gitcat** sits on the desk of the busiest agent (most tool starts in the last 10 min), naps on a Lounge sofa next to sleeping agents, and sometimes follows a smoker to the terrace.
    - **Claudio** greets every new arrival at the Entrance door, and runs over and bounces around an agent that just pushed or opened a PR.
  - **Fish tank**: a new sprite in the Lounge. Its bubble rate scales with the number of active agents.
  - **Receptionist**: an NPC seated at RECEPTION_DESK who waves when an agent walks in.
  - **Real clocks**: the wall CLOCK sprites draw hands showing the PC's local time.
  - **Pizza party**: after 3+ PRs in a local day, pizza boxes appear on the Cafe tables until midnight. Awake idle agents sometimes take a slice.
  - **Ping-pong**: a new table sprite in the Lounge. When 2+ agents are idle-awake and not smoking, sometimes two play a 30-60 s rally.
  - **Printer**: a new sprite. It prints a page (paper slides out) when a session Writes a `.md`, `.pdf`, `.docx` or `.txt` file.
  - **Notice board**:
    - A wall board listing open PRs and issues for the repos seen today.
    - The server polls `gh` every 10 min, via execFile with no shell, and only if `gh` is authenticated.
    - Titles only.
  - **Growing plants**: plants in Dev and Lounge grow through 3 stages over the week with the week's PR count (from the daily files). They reset on Monday.
- **G. Functional** (approved 2026-10-18):
  - **"Needs you" inbox**: a 📥 N button by the TODAY strip (a chip on phones) listing every agent waiting on the user, oldest first. Each row has a reason (✅ turn done / 🔐 permission / ❓ question), `title · repo · machine` and the wait time, which turns red after 15 min.
  - **Open in Claude**:
    - Transcripts record `{"type":"bridge-session","bridgeSessionId":"cse_…"}` while Remote Control is on, and the user's settings turn it on at startup.
    - Link: `https://claude.ai/code/` + the id with `cse_` replaced by `session_`.
    - Without one, show a copy button with `cd <cwd> && claude --resume <sessionId>`.
    - Remote (Mac) sessions get the copy fallback; their session id is the relay's id without the `<source>:` prefix.
  - **Usage-limit tracker**:
    - Detected (best-effort) from the `StopFailure` hook payload, transcript API-error records (`isApiErrorMessage`, error type `rate_limit`), and Notification messages mentioning a usage limit. Parse the reset time when present.
    - The agent shows ⏸️ "paused until <time>" and is not routed as "waiting on you".
    - The inbox has a "Paused by usage limit" group.
    - The TODAY strip shows "⏸️ N paused · resume <time>".
    - The flag clears at the reset time or on the next activity.
  - **Time per repo + CSV** (after M and the token meter):
    - A "Time" tab in the Tasks board with a week table per repo: active hours, tasks, PRs, pushes, tokens, est. $. Day drill-down.
    - CSV export (week or month): one row per repo per day.
    - Read-only clients may view and export.
- **H. Looks + TV mode** (approved 2026-10-18):
  - **Clawd agents**:
    - Agents (sessions and sub-agents) are drawn as Clawd, Claude Code's orange pixel mascot, instead of the chibi people.
    - Each gets a colour tint and an accessory (cap, headset, beanie, bow, glasses, antenna), stable per repo.
    - Ansh, the Manager and the receptionist stay human, so people and sessions read apart.
    - A Settings toggle switches between Clawd (the default) and Classic.
  - **TV mode**:
    - Full screen with the controls hidden. The office, agent labels, TODAY strip and approval cards stay, and the 📥 count stays as a passive badge.
    - Entered with a button, the T key or `?tv=1` (it works alongside `?token=`). Exit with Esc, T, or an Exit button that fades in when the mouse moves.
    - The cursor hides when idle, the office auto-fits, and a wake lock is taken when the browser allows it.
