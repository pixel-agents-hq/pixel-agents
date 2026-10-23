<h1 align="center">
  <img src="webview-ui/public/banner.png" alt="Pixel Agents">
</h1>

<p align="center">Your Claude Code sessions as characters in a pixel-art office, on any screen.</p>

Pixel Agents turns every Claude Code session into an animated character. Characters walk to a desk, type while the agent edits files, read while it searches, and walk to other rooms when they're waiting on you, asking for permission, or running tests. Sessions from this computer, your other computers and claude.ai/code cloud sessions can all appear in the same office.

This repository is a fork of [pixel-agents-hq/pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) (MIT). It keeps everything upstream does and adds a lot on top, mostly to the standalone browser board. See [What this fork adds](#what-this-fork-adds).

![Pixel Agents office](webview-ui/public/office.png)

> **Run this fork from source.** The `pixel-agents` package on npm and the extension on the VS Code Marketplace and Open VSX are upstream's releases. They don't include this fork's features. See [Getting started](#getting-started).

## Contents

- [What this fork adds](#what-this-fork-adds)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Watching from a phone or a TV](#watching-from-a-phone-or-a-tv)
- [Sessions from other computers and the cloud](#sessions-from-other-computers-and-the-cloud)
- [Features](#features)
- [Office MCP server](#office-mcp-server)
- [Settings and switches](#settings-and-switches)
- [Data on disk](#data-on-disk)
- [How it works](#how-it-works)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Credits and license](#credits-and-license)

## What this fork adds

Most of these live in the standalone board (`node dist/cli.js`). The VS Code panel gets the office and look changes, but not the server-side parts (approvals, Manager, Ansh's brain, alerts, MCP).

- **Remote sessions.** Other computers and cloud sessions send their hook events to a small relay behind Tailscale Funnel. They show up with a 💻 or ☁ badge.
- **A living office.** Rooms with meaning: a lounge for sleeping sessions, a smoking balcony for sessions waiting on you, a meeting room for questions, a server room for test runs, a café, an entrance where characters arrive and leave.
- **Approvals from the board.** Answer a permission request from the board or your phone, not only the terminal.
- **Status at a glance.** Stage track per agent, a waiting timer, a "Needs you" inbox, failure and loop warnings, a per-agent timeline, usage-limit pauses, and a TODAY strip with PRs, pushes, files, commands, hours and tokens.
- **The Manager.** A task log built from session titles, a Tasks board, time per repo with CSV export, and a daily report written by `claude -p`.
- **Ansh.** Your own character. It watches the office, walks over to agents that need attention, and comments in one line.
- **Usage meter.** Your Claude subscription's 5-hour and weekly usage on a wall display in the server room.
- **Phone alerts** through ntfy when an agent has waited on you too long.
- **Office life.** Celebrations for PRs and pushes, trophies, day/night windows with real weather, live clocks, festivals, smart pets, a lo-fi radio, ping-pong, a notice board of open PRs and issues, and more.
- **Clawd look.** Draw agents as Clawd, Claude Code's orange mascot, instead of the classic characters.
- **TV mode.** A full-screen, controls-hidden board for a wall display.
- **An office MCP server.** Ask Claude about your other agents with five read-only tools.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and signed in
- Node.js 20 or later
- Windows, macOS or Linux
- For the VS Code extension: VS Code 1.105.0 or later

## Getting started

### Standalone board (recommended)

```bash
git clone https://github.com/anshhoff/pixel-agents.git
cd pixel-agents
npm install
npm run build
node dist/cli.js --port 3100
```

The CLI prints a URL ending in `?token=...`. Open it.

1. The first time, a greeter walks you through a short intro and asks before installing hooks into `~/.claude/settings.json`. Hooks give instant, reliable status. Without them, Pixel Agents falls back to reading transcripts.
2. In **Settings**, turn on **Watch All Sessions** to see sessions from every project, not only the folder you started from.
3. Click **+ Agent** and pick a Directory to start Claude Code in the browser terminal. Sessions you start in your own terminal are picked up too.

Without `--port`, the server picks a free port on every start, so a bookmarked URL stops working after a restart. Use a fixed port.

#### Options

| Option                  | Effect                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--port`, `-p <number>` | Port to listen on. Default: a free port chosen by the OS.                                                                                                         |
| `--host <string>`       | Address to bind to. Default: `127.0.0.1`. Binding to `0.0.0.0` exposes the board to your network.                                                                 |
| `--allowed-host <name>` | Also accept the tokened URL under this host name, for example a Tailscale Serve name. Repeatable. Without it, only localhost and a specific `--host` are trusted. |
| `--rotate-token`        | Replace the server token. Every URL that carried the old one stops working.                                                                                       |
| `--no-terminal`         | Turn off the browser terminal. You can watch agents but not launch or attach to them.                                                                             |
| `--help`                | Show the help.                                                                                                                                                    |

#### The token URL is a secret

The `?token=` in the URL is what lets a browser change things: install hooks, launch agents, attach to terminals, answer permission requests. Anyone with the URL can do those things from anywhere the board is reachable.

- Don't paste it into a shared channel. It's also saved in your browser history. The server's own log hides it.
- A browser without the token gets a **read-only** board. It can watch the office and read the Tasks board, nothing else. That's what you want on a wall display.
- The token is stored in `~/.pixel-agents/standalone-token` (readable only by you) and survives restarts. `--rotate-token` replaces it.

Stop the board with **Ctrl+C**.

### VS Code extension

Open this repository in VS Code and press **F5**. That starts an Extension Development Host with the fork's extension loaded. Open the **Pixel Agents** panel beside the terminal and click **+ Agent**.

The extension and the standalone board can run at the same time. Each registers itself under `~/.pixel-agents/servers/`, and the hook sends every event to all of them. They keep separate agents, seats and settings, and share the office layout.

### Use the full office layout

The living office needs rooms. A ready-made layout and the sprites it uses ship in this repo:

1. **Settings → Add Asset Directory**, and pick `remote/office-pack`.
2. **Settings → Import Layout**, and pick `remote/layouts/office-with-rooms.json`.

Rooms are Areas with reserved names: `Entrance`, `Dev`, `Smoke`, `Lounge`, `Meeting`, `Server`, `Cafe`, `Ansh` and `Manager`. In your own layout, paint Areas with these names to get the same behaviour. A layout without them still works; characters just stay at their desks.

## Watching from a phone or a TV

**Phone.** Below a phone-sized width the board turns into a two-page app: the office, and a terminal page for the agent you pick. A row of agent cards sits at the bottom. Add it to your home screen and it opens like an app.

To reach the board from your phone without exposing it to the internet, put both devices on the same [Tailscale](https://tailscale.com) tailnet and serve the board inside the tailnet only:

```bash
tailscale serve --bg --https=3443 http://127.0.0.1:3100
node dist/cli.js --port 3100 --allowed-host <machine>.<tailnet>.ts.net
```

Open `https://<machine>.<tailnet>.ts.net:3443`. Without the token it's read-only. With the token and `--allowed-host`, you can also approve permission requests and launch agents from the phone.

**TV mode.** Full screen with the controls hidden, for a second monitor or a wall display. The office auto-fits, the cursor hides, and the screen is kept awake where the browser allows it. Enter it with the TV button, the **T** key, or `?tv=1` in the URL. Leave with **Esc**, **T**, or the Exit button that appears when you move the mouse.

## Sessions from other computers and the cloud

One computer runs the board and a small relay. Only the relay is exposed to the internet, through Tailscale Funnel, and it accepts a single `POST /ingest` route. Other computers and claude.ai/code cloud sessions send their hook events to it with their own key. The board itself is never exposed.

```
this computer   Claude Code ── local hook ─────────────────► board 127.0.0.1:3100
other computer ── curl + key ──┐                                 ▲
                               ├─► Tailscale Funnel ─► relay ────┘
cloud session ─── curl ────────┘
```

Remote sessions show tool activity, permission bubbles, Done/Waiting and sub-agents. They don't get a context gauge or teammate detection, because the transcript stays on the other machine, and their permission requests are answered in their own terminal, not from the board. The board only updates while the host computer is on.

Setup, including keeping the board and relay running at login on Windows and macOS: [remote/README.md](remote/README.md). Design: [docs/remote/DESIGN.md](docs/remote/DESIGN.md).

## Features

### The office

- **One character per session.** Sub-agents appear as helpers next to their parent. Agent Teams teammates get their own characters, and the lead wears a crown.
- **Live activity.** Characters type while the agent edits or runs commands, and read while it searches or fetches.
- **Rooms that mean something** (with a layout that has them):
  - sleeping sessions go to the Lounge
  - questions go to the Meeting room
  - permission requests knock on Ansh's door
  - test and build commands send the agent to the Server room
  - a finished turn waiting on you means a cigarette on the Smoke balcony
  - short gaps mean a coffee run to the Café
  - new sessions walk in through the Entrance, and closed ones walk out
- **Speech bubbles** for permission requests and finished turns, and an optional chime.
- **Labels** with the session's task title and repo, a context gauge, and the stage track.
- **Two looks.** Classic characters (the default) or Clawd, with a colour and an accessory per repo. Change it in **Settings → Agent Look**.
- **Layout editor.** Click **Layout** to paint floors and walls, place, rotate, recolour and copy furniture, paint carpets, add pets, and paint named Areas. Undo and redo, import and export as JSON. Layouts grow up to 64×64 tiles.
- **Directories and Areas.** **+ Directory** saves a named folder to launch agents in, optionally tied to Areas where its agents prefer to sit.
- **External asset packs** for furniture, characters and pets. See [docs/external-assets.md](docs/external-assets.md).

### Knowing what needs you

- **Stage track** on each label: `EXPLORE · BUILD · TEST · SHIP`, from the tools the agent runs.
- **Waiting timer**: `⏳ waiting on you 14m`. It turns yellow at 5 minutes and red at 15.
- **"Needs you" inbox** (📥): every agent waiting on you, oldest first, with the reason: turn done, permission, or question.
- **Open in Claude**: a link to the session on claude.ai/code when Remote Control is on. Otherwise, a copyable `claude --resume` command.
- **Trouble signals**: a 🔥 on the desk for each failed tool, a red alarm after three in a row, and 🌀 when an agent seems to be going in circles.
- **Timeline**: click a character to see its last actions, today's PRs and pushes, and its time worked.
- **Usage-limit pauses**: an agent that hit a usage limit shows ⏸️ with its reset time instead of "waiting on you".
- **TODAY strip**: PRs, pushes, files edited, commands, active hours and tokens for the day, with an estimated cost.
- **Phone alerts**: one [ntfy](https://ntfy.sh) notification per wait when an agent has waited on you for 15 minutes. Turn it on by creating `~/.pixel-agents/alerts.json` with `{ "ntfyTopic": "<your topic>" }`. You can also set `ntfyServer` and `waitMinutes`. The message contains the task title and repo only.

### Acting from the board

- **Approvals.** When a session asks for permission, the board shows the request with Allow and Deny. Claude Code shows its own prompt at the same time, and whichever is answered first wins. Only plain allow or deny is sent back, never "always allow". Answers are logged to `~/.pixel-agents/approvals.log`. Standalone only, for sessions on the board's own computer.
- **Browser terminal.** Launch Claude Code from **+ Agent** and drive it in the browser, on desktop or phone. Copying is verbatim. **Alt+C** (**Option+C** on a Mac), or **Copy as text** on a phone, joins Claude Code's wrapped lines into flowing text.
- **Skip Permissions.** **Settings → Skip Permissions** launches new agents with `--dangerously-skip-permissions`. Only turn it on if you accept what that means.

### The Manager and Ansh (standalone)

- **Task log.** Each session's title period is a task: in progress, waiting on you, or done, with its PRs, pushes, files, commands and active time. Stored per day under `~/.pixel-agents/tasks/`.
- **Tasks board.** Click the Manager to see a kanban of today's tasks, earlier days, the daily report, and a **Time** tab with time per repo for the week (active hours, tasks, PRs, pushes, tokens) and a CSV export.
- **Daily report.** At 19:00 the Manager writes a short report with `claude -p` (tools off) and walks it into Ansh's office. **Write report now** does it on demand. If Claude can't run, a plain template report is written instead.
- **Ansh's brain.** Every 20 seconds Ansh looks at the office. When something important changes (at most every 5 minutes, with a daily cap), it asks `claude -p` for one move (visit an agent, talk to the Manager, stretch, or stay) and one line of comment. Ansh can only watch and comment. It has no way to answer, launch or message anything. Click Ansh to see its thoughts, turn it on or off, or ask it something.

### Usage meter

**Settings → Usage Meter (Server Room)** shows your Claude subscription's 5-hour and weekly usage, with reset times, on a display above the server racks. Claude Code only reports these numbers to a status line, so turning this on installs a `statusLine` in `~/.claude/settings.json`. That status line prints a short line in your terminal, such as `Opus 5.5 | 5h 23% (resets 6:30 PM) | 7d 41%`. A status line of your own is never replaced; the setting then shows that one is in the way. Needs a Pro or Max plan.

### Office life

- **Celebrations**: a bell, confetti and a trophy on the trophy wall for every PR and push. Pizza after three PRs in a day.
- **Ambience**: windows that follow the time of day and show the real weather, dimmed lights at night, wall clocks with real time, name plates on desks.
- **Rituals and festivals**: a 10:00 standup in the Meeting room, an end-of-day banner at 19:00, and Diwali, Holi and New Year decorations.
- **Smart pets**: Gitcat sits on the busiest agent's desk. Claudio greets new arrivals and bounces around an agent that just shipped.
- **More**: a receptionist who waves, a fish tank that bubbles faster when more agents work, ping-pong between idle agents, a printer that prints when a session writes a document, plants that grow with the week's PRs, a week wall with streaks, and a lo-fi radio in the Lounge.
- **Notice board**: open PRs and issues for today's repos, polled with `gh` every 10 minutes when `gh` is signed in. Titles only.

## Office MCP server

The standalone board is also an MCP server, so a Claude Code session can ask about your other agents. Its five tools are read-only:

| Tool                | Returns                                                       |
| ------------------- | ------------------------------------------------------------- |
| `list_agents`       | Every agent in the office, with ids                           |
| `read_agent`        | The end of one agent's transcript: prompts, replies, failures |
| `pending_approvals` | Permission requests waiting for an answer                     |
| `tasks_today`       | Today's task log                                              |
| `usage`             | The subscription usage the meter shows                        |

Connect it (replace `3100` with your port, and the token with the contents of `~/.pixel-agents/standalone-token`):

```bash
claude mcp add --transport http pixel-agents http://127.0.0.1:3100/mcp \
  --header "Authorization: Bearer <token>"
```

Text that came from an agent is marked as data in every tool result.

## Settings and switches

The **Settings** panel covers sound, Watch All Sessions, Instant Detection (Hooks), Always Show Labels, the usage meter, Agent Look, Show Areas, Skip Permissions, Show Start Directory, asset directories, layout import/export, and a Debug View.

Environment variables for the standalone board:

| Variable                         | Effect                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `PIXEL_AGENTS_APPROVALS=off`     | The permission hook never waits on the board. `"approvalsEnabled": false` in `~/.pixel-agents/config.json` does the same. |
| `PIXEL_AGENTS_ANSH_BRAIN=off`    | Ansh never runs `claude`. It uses built-in thoughts.                                                                      |
| `PIXEL_AGENTS_MANAGER=off`       | Neither the Manager's report nor Ansh runs `claude`. Reports use the template.                                            |
| `PIXEL_AGENTS_WEATHER=off`       | No network lookups for the weather in the windows.                                                                        |
| `PIXEL_AGENTS_NOTICE_BOARD=off`  | Never run `gh` for the notice board.                                                                                      |
| `PIXEL_AGENTS_SESSION_LIST=off`  | Don't run `claude agents --json`, which is used to spot sleeping and background sessions.                                 |
| `PIXEL_AGENTS_CLAUDE_BIN=<path>` | Use this executable instead of `claude` on `PATH`.                                                                        |
| `PIXEL_AGENTS_LOG_LEVEL=warn`    | Quieter server log, for a board that runs all the time.                                                                   |

`0`, `false` and `no` work like `off`.

The weather feature guesses your city once from your IP address (ipapi.co, then ip-api.com) and fetches the weather from Open-Meteo. No key is needed. The city is cached in `~/.pixel-agents/weather-location.json`.

## Data on disk

Pixel Agents never modifies Claude Code. It adds entries to `~/.claude/settings.json` only after you agree (hooks) or turn the usage meter on (status line), and removes them when you turn them off. Before its first change it saves a backup next to the file. Everything else lives under `~/.pixel-agents/`:

| Path                                         | Contents                                               |
| -------------------------------------------- | ------------------------------------------------------ |
| `config.json`                                | Settings, hook consent, asset directories              |
| `layout.json`                                | The office layout, shared by every surface             |
| `standalone-state.json`, `vscode-state.json` | Agents and seats per surface                           |
| `standalone-token`                           | The standalone server token                            |
| `servers/`                                   | One registration per running server                    |
| `hooks/`                                     | The hook and status line scripts                       |
| `daily/`, `tasks/`, `reports/`, `tokens/`    | Daily totals, task log, Manager reports, token counts  |
| `ansh/`                                      | Ansh's state                                           |
| `usage.json`                                 | The latest subscription usage                          |
| `approvals.log`                              | One line per permission answered from the board        |
| `alerts.json`                                | Your ntfy settings (you create it)                     |
| `relay.json`                                 | Relay sources, with hashed keys (remote sessions only) |

## How it works

Claude Code reports what it's doing in two ways, and Pixel Agents uses both:

- **Hooks** (preferred). A small hook script receives events like `SessionStart`, `PreToolUse`, `PermissionRequest` and `Stop`, and posts them to every running board.
- **Transcripts** (fallback). Without hooks, status is inferred from the JSONL transcripts under `~/.claude/projects/`. Transcripts are also read in hooks mode for titles, tokens and context use.

Both become one shared event model. A runtime updates a central state store, and the store's changes are sent to the browser over WebSocket (standalone) or to the VS Code panel. The office is drawn on a Canvas 2D with pathfinding and character state machines.

The code is layered:

- `core/`: the protocol and interfaces, including the AsyncAPI contract that the message types are generated from
- `server/`: the runtime, the Claude provider, persistence, the Fastify server and the standalone CLI
- `adapters/vscode/`: the VS Code extension
- `webview-ui/`: the React and Canvas office, shared by both surfaces
- `remote/`: the relay, the office sprite pack and layout, and the autostart scripts

For more detail, see [CLAUDE.md](CLAUDE.md) (architecture reference), [CONTEXT.md](CONTEXT.md) (glossary), and the design notes in [docs/](docs/).

## Development

```bash
npm install          # root and all workspaces
npm run build        # generate protocol types, type-check, lint, bundle, build the webview
npm run watch        # rebuild the extension and CLI on change
cd webview-ui && npm run dev   # Vite dev server for the webview, in a second terminal
```

Press **F5** in VS Code for the Extension Development Host. Run the standalone build with `node dist/cli.js`.

Checks:

```bash
npm run check-types
npm run lint
npm test             # webview, server, npm package contract and relay tests
npm run e2e          # Playwright, against VS Code and the standalone board
```

The VS Code end-to-end tests open real VS Code windows that take keyboard focus. The standalone ones run in a headless browser. See [e2e/README.md](e2e/README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

`core/src/messages.ts` is generated from `core/asyncapi.yaml` by `npm run asyncapi:generate`. Edit the YAML, never the generated file.

## Troubleshooting

- **The board won't start.** Check Node.js 20+, and that nothing else uses the port.
- **An agent is missing.** Check that **Instant Detection (Hooks)** is on, and turn on **Watch All Sessions** for sessions outside the start folder.
- **Buttons do nothing or say the board is read-only.** You opened the URL without `?token=`, or under a host name you didn't pass with `--allowed-host`.
- **Something looks wrong.** **Settings → Debug View** shows the connection, transcript paths and the latest data per agent.
- **Remote sessions don't appear.** See the troubleshooting section of [remote/README.md](remote/README.md).

## Credits and license

Pixel Agents was created by [Pablo De Lucca](https://github.com/pablodelucca) and the contributors to [pixel-agents-hq/pixel-agents](https://github.com/pixel-agents-hq/pixel-agents). This fork builds on their work. The classic characters are based on [JIK-A-4's Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack) pack.

Available under the [MIT License](LICENSE).
