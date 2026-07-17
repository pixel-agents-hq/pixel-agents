# Using Pixel Agents

A practical walkthrough of everything in the Pixel Agents panel — from
spawning your first agent to customizing the office. For install steps, see
the [README Getting Started](../README.md#getting-started) section; for
what the project _is_, see the [README](../README.md) itself.

## Opening the panel

- **VS Code extension** — the Pixel Agents panel appears in the bottom
  panel area, next to your terminal. If it's not visible, open the Command
  Palette and run **Pixel Agents: Show Panel**.
- **Standalone CLI** — run `npx pixel-agents` (or `node dist/cli.js` from
  source) and open the printed `http://localhost:3100` URL in a browser.
  The **+ Agent** button is hidden in this mode (there's no VS Code terminal
  to spawn into) — spawn agents the normal way (`claude` in a terminal) and
  they'll appear automatically once hooks or heuristic detection picks them
  up.

## Spawning and managing agents

- **+ Agent** launches a new Claude Code terminal and gives it a character.
  If your workspace has multiple folders, clicking it opens a folder picker
  first.
- **Hover** (not right-click) the **+ Agent** button to reveal **"Skip
  permissions mode ⚠"** — pick it to launch with
  `--dangerously-skip-permissions`, which bypasses all tool approval
  prompts. Use with care.
- **Click a character** to select it (click again to deselect). Selecting
  an agent also makes the camera follow it and focuses its terminal.
- **With an agent selected, click a seat**: its own seat sends it back to
  sit, an empty seat reassigns it there. Sub-agents (Task tool helpers)
  can't be reassigned — they're transient by design.
- **Right-click a tile** while an agent is selected to send it walking
  there.
- **Click a pet** to toggle a heart bubble.

## Reading agent activity

Characters animate based on what the agent is actually doing — typing when
writing code, reading when searching files, walking between seats. Speech
bubbles surface the moments that need you:

- A **permission bubble** means the agent is blocked on a tool-approval
  prompt.
- A **waiting bubble** means the agent finished its turn and is waiting for
  your next message.

Turn on **Sound Notifications** (Settings) to get an audio cue for both —
a "done" chime when an agent starts waiting, a different chime when it
needs a permission decision.

## Layout editor

Click **Layout** in the bottom toolbar to enter edit mode and design your
office:

- **Floor** — full HSB color control, plus selectable floor patterns
  (checkerboard, wood plank, brick, and more).
- **Walls** — auto-tiling walls with color customization.
- **Tools** — select, paint, erase, place, eyedropper, pick.
- **Furniture** — drag from the palette to place; click a placed item to
  select it.
- The grid expands up to 64×64 tiles — click the ghost border outside the
  current grid to grow it.

**Keyboard shortcuts** (while the editor is open):

| Key                                          | Action                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| `Ctrl`/`Cmd`+`Z`                             | Undo                                                                            |
| `Ctrl`/`Cmd`+`Y` or `Ctrl`/`Cmd`+`Shift`+`Z` | Redo                                                                            |
| `R`                                          | Rotate selected furniture                                                       |
| `T`                                          | Toggle furniture state (e.g. on/off)                                            |
| `Delete` / `Backspace`                       | Delete selected furniture                                                       |
| `Esc`                                        | Step back: deselect placed item → exit tool → deselect furniture → close editor |

Undo/redo holds 50 levels. **Export/Import** (Settings modal) share a
layout as a JSON file.

## Multi-floor buildings

An office can have more than one floor — each a fully independent grid with
its own furniture, seats, agents, and pets. Add, switch, rename, and delete
floors from the Layout toolbar. See [docs/multi-floor.md](multi-floor.md)
for the full guide.

## Department board

Click **Board** in the bottom toolbar to see a live per-floor roster
(staff, help wanted, open items) plus a manual notes field for that floor.
See [docs/department-board.md](department-board.md) for the full guide.

## Settings

Click the gear icon (**Settings**) to open the settings modal:

- **Open Sessions Folder** — opens the folder containing session data.
- **Export Layout** / **Import Layout** — share your office as a JSON file.
- **Add Asset Directory** — register a folder of custom or third-party
  furniture. See [docs/external-assets.md](external-assets.md) for the
  manifest format. Each registered directory can be removed with the **×**
  next to its name.
- **Sound Notifications** — audio cue when an agent starts waiting or needs
  a permission decision.
- **Watch All Sessions** — watch every Claude session instead of only the
  active one.
- **Instant Detection (Hooks)** — use Claude Code's Hooks API for instant
  status updates instead of polling transcript files.
- **Always Show Labels** — keep name/status labels visible on every
  character instead of only on hover.
- **Debug View** — connection diagnostics per agent (JSONL file status,
  lines parsed, last data timestamp) — useful when an agent looks stuck.
  See [README Troubleshooting](../README.md#troubleshooting).

## Where to go next

- [docs/multi-floor.md](multi-floor.md) — floors in depth
- [docs/department-board.md](department-board.md) — the roster + notes panel
- [docs/external-assets.md](external-assets.md) — custom furniture packs
- [README Troubleshooting](../README.md#troubleshooting) — if an agent
  won't spawn or appears stuck
