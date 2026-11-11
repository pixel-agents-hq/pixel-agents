# Pixel Agents

Pixel Agents turns AI coding sessions into animated characters in a pixel-art office. This glossary is the canonical language for contributors and integrators; end-user docs may simplify it but must never contradict it.

## Hosts & Adapters

**Host**:
The machine Pixel Agents runs on — a laptop, a phone, a VPS, a Raspberry Pi. The office is the same on every host, and can be reached from another device.
_Avoid_: platform, environment, server (that's the runtime process)

**Adapter**:
The integration that connects one editor or application — VS Code, standalone, a macOS app, and the like — to Pixel Agents. An adapter composes the runtime and the office UI, and binds them to that environment's terminals, storage, and conventions. One adapter per editor or application; VS Code and standalone are the two today.
_Avoid_: host (that's the machine it runs on), surface, flavor, platform, edition

**Standalone**:
The adapter that serves the office to a browser from a local server, independent of any editor.
_Avoid_: CLI (that's the entry command, not the adapter), browser mode

**Read-only office**:
A standalone office opened without the server's token, or under a host name the operator didn't allow. It shows everything live, but changes nothing: no launching, no layout edits, no settings.
_Avoid_: guest mode, watch-only, untokened (that's how it happens, not what it is)

## Agents & Teams

**Agent**:
An AI coding session tracked by Pixel Agents, whether spawned from the office or adopted from an external terminal.
_Avoid_: bot, terminal (as a synonym), session (as a synonym)

**Headless agent**:
An agent with no terminal — a non-interactive run adopted from outside the office, for example. A full citizen: it has a seat and can be selected, but there is no terminal to focus. Agents it spawns are sub-agents or teammates like anyone else's. Optionally drawn as a Ghost.

**Character**:
The animated pixel-art figure representing an agent in the office. An agent has a status and a session; its character has a position and an animation state.
_Avoid_: avatar, sprite (a sprite is the image asset, not the figure)

**Ghost**:
A character drawn translucent because its agent is headless — the visual shorthand for "nothing to focus here". Opt-in: off unless the user turns on "Display Headless as Ghosts", and never used in adapters without terminals, where every agent would qualify and the cue would say nothing. Teammates and sub-agents are never ghosts; clicking one reaches its lead's or parent's terminal.
_Avoid_: faded, dimmed, transparent, inactive (that's a status)

**Sub-agent**:
An unnamed piece of delegated work spawned by an agent, visualized with its own character near its parent — around it, not in a seat. Not an Agent (no session of its own) and not a Teammate (no name). It exists only for the duration of its task, which may outlive the parent's turn. Having no name is what makes it a sub-agent.
_Avoid_: subtask (UI label prefix only)

**Team**:
A Lead plus the Teammates it spawned. A team exists because a teammate was spawned — whether or not the CLI recorded one. A CLI's team registry is evidence of a team, never its definition.

**Lead**:
The agent that spawned a Team's teammates. An agent becomes a lead the moment it spawns its first teammate.
_Avoid_: parent (that's the sub-agent relationship), orchestrator

**Teammate**:
A named agent spawned by another agent — the name is what makes it a teammate. Its spawner is its Lead, and together they form a Team. Every teammate has its own transcript and sits in a seat; it may or may not have its own session or terminal — how it runs never changes what it is.
_Avoid_: inline teammate, tmux teammate, session teammate (former run-style distinctions; a teammate's run style is a property, not an identity)

## Agent Lifecycle

**Launch**:
Start a new agent from the office.
_Avoid_: spawn (that's the character-level visual event), create

**Directory**:
A named filesystem location agents can be launched into. Directories come from two sources: defined by the user in the office, or contributed by the host — VS Code contributes its workspace folders, standalone contributes the directory the server was started from. Host-contributed directories cannot be edited in the office.
_Avoid_: folder, workspace folder (that's the VS Code-contributed source, not the concept), project (everyday speech for one, as in a headline like the Tutorial's "Add a project"; never as the term)

**Worktree**:
A separate checkout of a Directory's repo on its own branch, created by Pixel Agents for one agent's work and cleaned up when it leaves. A Worktree agent is still an agent of its Directory. Its states, in UI copy too: **running** (an agent works in it), **kept** (its folder stays by the user's choice), **parked** (folder removed, branch kept: it has commits of its own), **needs a decision** (its agent left uncommitted changes; the answer is Save & remove, Keep folder or Discard). "Commits of its own" are the branch's commits whose changes are not in its base, so squash- or rebase-merged work counts as none. A worktree the CLI made itself in the same folder (Claude Code: `claude -w`, EnterWorktree) is a **CLI worktree**, never a Worktree: the office lists it and removes it only at the user's word.
_Avoid_: workspace, quest, sandbox

**Nickname**:
An optional name given to an agent at launch, shown after its Directory ("app · reviewer · fix-login"). It only labels the agent; it never makes it a teammate.
_Avoid_: name (reserved for Teammates), title (that's the conversation's), label

**Adopt**:
Begin tracking a session that was started outside the office. An adopted agent is a full citizen.
_Avoid_: import, attach

**Spawn / Despawn**:
The character-level visual event: a character materializing into or dissolving out of the office. An agent is launched or adopted; its character spawns.

**Dismiss**:
Remove an agent from the office by user choice, without judging its session. A dismissed session is not re-adopted.
_Avoid_: close, delete

**Orphaned**:
An agent whose transcript has been deleted, so the session it represents no longer exists. The office removes orphaned agents automatically.
_Avoid_: stale (implies inactivity or age, which never removes an agent), dead, ended

## Interaction

**Select**:
Mark a character as the current subject in the office (the white outline). Selection is what seat reassignment operates on.
_Avoid_: focus (reserved for terminals), highlight

**Follow**:
The camera tracking the selected character. Ends on manual pan or deselection.
_Avoid_: track

**Focus**:
Bring an agent's terminal to the front. Reserved exclusively for terminals — never the in-office highlight.

**Message**:
Text or named keys one agent types into another agent's terminal: a request, or an answer to the prompt or menu on its screen. The sender reads the recipient's screen first and the message is refused if that screen changed since. Its character walks to each recipient and faces it, the gist in its speech bubble; delivery never waits for the walk. Text arrives tagged with the sender's name.
_Avoid_: prompt (that's what the user types), chat, DM

**Card bar**:
The row of cards for the office's terminals: one card per running main agent (teammates and sub-agents get none) and one per live PC shell, in one order the user can drag and every open office shares. Pressing a card reaches its agent or shell. A PC shell's card shows the PC and its Directory's name (or "Home"), with no status dot and no context gauge, since a shell is not an agent; its × ends the shell, asking first while a command still runs in it.
_Avoid_: agent list, tabs, roster (that's the characters to launch as)

**Roster**:
The characters an agent can be launched as, one card each, most recently launched first — opened by the arrow beside the New agent button. Picking one launches a new agent wearing it; its `+ New` adds a character to the cast (it launches nothing).
_Avoid_: agent picker, agents (it lists characters, not running agents), card bar

**New agent**:
The `+` card that launches an agent. From it, a Directory is chosen; from the roster, a character too.
_Avoid_: `+ New` (that's the roster's add-a-character slot)

**Item**:
One wearable part in the Characters view's wardrobe (a hairstyle, a top, a hat, an accessory). Built-in items ship with the app; custom items are ones the user saved from the pixel editor ("Save as new item"), worn by any character and drawn in the colours of the built-in item they started from. A piece sheet is one item's frames alone, uncoloured, as a 128×96 PNG (Export / Import PNG).
_Avoid_: part (the code's word, fine there), asset, sprite

**Wardrobe**:
Everything a character is made of: the items for each slot (built-in and custom), the bodies, eye shapes and eye colouring, and the colours each part can take — named colours, a part's own colourways, or any colour fitted to its shading. Characters are dressed from it in the Characters view, and agents read it through the Pixel Office MCP to make or restyle one.
_Avoid_: closet, inventory, asset list

## First Run

**Intro**:
The first-run tour the Greeter speaks: welcome, getting Claude Code (only when it isn't installed), choices, all set. The choices step asks for the usage bars, live updates (hooks) and the Pixel Office MCP, one box each, all off to start, not a separate dialog per ask; someone who finished the Intro before an ask existed is greeted with that ask alone. Where the Tutorial can run, the all-set step asks to start it, saying what that does. The Intro itself is scripted: no session, no tokens.
_Avoid_: onboarding, tutorial (that's what it offers), wizard, consent modal

**Greeter**:
The character that speaks the Intro. Not an agent and not a Pet: it has no session, takes no seat, never wanders, and exists exactly as long as the Intro is open.
_Avoid_: mascot, tutorial character

**Tutorial**:
The optional hands-on tour offered at the end of the Intro (or from Settings): the Greeter walks to a seat and sits, and there becomes the Guide. The Guide opens by saying what Pixel Agents is, then asks whether the user wants to try something in particular or be shown around; either way it suggests what fits next, and the user does the Quests in any order. Starting it is asked for on its own, because it starts a Claude Code session; quitting it closes that session. Not the Intro, and not an agent of its own: it is the run the Guide is on.
_Avoid_: onboarding (alone), walkthrough, game mode

**Guide**:
The agent giving the Tutorial: a real agent with a terminal, following its Onboarding skill over the Pixel Office MCP. It wears the Greeter's character and goes by that character's name (Byte, unless the user renamed it).
_Avoid_: tutorial agent, host, greeter (that's the Intro's character before it sits down)

**Onboarding skill**:
The Claude Code skill (`pixel-agents:onboarding`) that tells the Guide how to give the Tutorial. Loaded for that one session from a plugin folder the office writes under `~/.pixel-agents` (`--plugin-dir`); never installed.
_Avoid_: brief, script, prompt

**Quest**:
One of the Tutorial's few first steps in the office, shown in its checklist ("Create a character"), done in any order. Each completes when the office sees it happen, never because someone says so. The user may skip any, in the checklist or by asking the Guide. What the checklist leaves out (an Area for a Directory, its default characters) the Guide offers as it fits, untracked.
_Avoid_: task, mission, challenge, achievement, step (they have no order)

## Agent Status

**Active**:
An agent that is executing its turn.
_Avoid_: busy, working, running

**Inactive**:
An agent that is not executing. Comes in exactly three forms: done, waiting for input, or permission request.
_Avoid_: waiting (the wire protocol's historical umbrella term), idle

**Done**:
The inactive form where the agent finished its turn and nothing is pending.

**Waiting for input**:
The inactive form where the agent asked the user something and is blocked on a reply.

**Permission request**:
The inactive form where the agent is blocked until the user approves a tool use. Unlike the other two forms, it can occur mid-turn.

**Activity label**:
The human-readable line describing what an agent is doing right now (e.g. "Reading foo.ts"), shown above its character.
_Avoid_: status text, tool status

**Speech bubble**:
The indicator above a character announcing a form of inactivity: "…" for a permission request (stays until resolved), a checkmark for a finished turn (fades on its own). Also carries what a character says when its agent messages another: the message's one-line gist (under 80 characters), shown while it stands facing the recipient.
_Avoid_: bubble alone when ambiguous, notification

**Context gauge**:
The small bar under an agent's activity label showing how full its context window is. Every agent has one once it has taken a turn; sub-agents never do, having no session of their own. It reads the newest turn, so it falls when a session compacts or clears — it is a level, not a total.
_Avoid_: fuel gauge, health bar, token gauge (tokens are the unit, context is the thing)

## Office & Layout

**Office**:
The whole simulated world: the layout plus its inhabitants — characters and pets — and their live state.
_Avoid_: map, scene, room, level

**Layout**:
The office's spatial arrangement: the tile grid, floors, walls, carpets, areas, and furniture. It is the part of the office that the editor edits and that can be exported and shared.
_Avoid_: floor plan, blueprint, map

**Office view**:
A way of drawing the office. Every office view draws the same layout and the same characters; switching views changes how the office looks, never what is in it. There are two: Flat and Diorama.
_Avoid_: renderer (that's the code), mode, theme, skin

**Flat**:
The office view drawn as top-down pixel-art sprites on the tile grid. The default.
_Avoid_: classic, 2D, legacy

**Diorama**:
The opt-in office view that draws the office as a lit miniature: pixel-textured blocks, a tilted camera, light, shadow and lens effects.
_Avoid_: 3D mode, HD view

**Silhouette**:
How Diorama shows a character or pet standing behind a wall: a flat figure in one neutral colour, drawn through the wall. It says only "someone is there"; status still shows through speech bubbles. Not a Ghost: a ghost is about the agent (headless), a silhouette only about the view.
_Avoid_: x-ray, outline, ghost

**Mood**:
The lighting atmosphere a layout carries — sunlight, ambient light and colour grade, such as a sunny afternoon or a night shift. Part of the layout, so it travels with an exported layout. Only Diorama draws it.
_Avoid_: time of day, theme, weather

**Tile**:
One cell of the office grid.

**Floor**:
The walkable surface of a tile, painted with a pattern and color.

**Wall**:
A blocking tile that visually connects to adjacent walls.

**Carpet**:
A decorative layer painted over floor tiles.

**Area**:
A named, coloured region of tiles. Areas exist so directories can be mapped to them, and they are how people point at a part of the office ("the blue room"). Creating a room means making an Area (usually with floor and walls round it); deleting one removes the Area and its tiles.
_Avoid_: zone, region, room (what people call an Area; accept it in requests, don't make it a separate thing)

**Area mapping**:
The assignment of a directory to one or more areas. Many directories may share an area. Agents launched into a directory prefer seats inside any of its areas.

**Buildout**:
How an agent's layout edit appears in an open office: its character walks to the spot and works there while the new floor, walls and furniture appear one by one outward from it; what the edit removed dissolves in matrix rain. Only a show: the layout is already saved, and an office opened afterwards just shows the result.
_Avoid_: animation (too generic), construction

**Furniture**:
A placeable item in the layout — desks, chairs, storage, electronics, decor.
_Avoid_: object, prop, item

**Workshop**:
The host's personal collection of furniture under construction, live in every office on that host as it changes. Furniture leaves the workshop by being promoted into the bundled set that ships with Pixel Agents.
_Avoid_: sandbox, drafts, custom assets

**Desk**:
Furniture that seats face and that hosts surface items. An agent's character sitting at its desk is the visual expression of being active.

**Seat**:
A sittable spot the office derives from chair furniture, assignable to exactly one agent.
_Avoid_: chair (that's the furniture), workstation

**Chair**:
The furniture category whose items create seats. Every footprint tile of a chair yields one seat.

**Seat assignment**:
Which agent owns which seat. Persisted, and changeable by selecting a character and clicking a free seat.

**Pet**:
An animated creature that lives in the office and belongs to no agent. Purely decorative; wanders like a character.
_Avoid_: mascot, animal

**Wander**:
The stroll a character takes away from its seat while its agent is done. Characters whose agents are waiting for input or awaiting a permission stay seated.
_Avoid_: roam, patrol

**Visit**:
A character walking, on request, to a tile or to stand by a piece of furniture, facing a given way. It lingers a while, then wanders as usual; a visit asked to **stay** holds there until its agent has work.
_Avoid_: move (that's a session changing folders), teleport, goto

## Interactive Furniture

Panel, program and source are everyday words elsewhere; in this glossary they carry these meanings only when the subject is interactive furniture.

**Interactive furniture**:
Furniture that reacts to what happens in the office or can be used: by agents (through their agent events), by the user (in the office), by pushes from outside, or any mix. Every part is optional and declared by the furniture itself; furniture that declares none is plain furniture.
_Avoid_: interactable, smart furniture, widget, appliance

**Piece**:
One placed item of furniture in the layout. Two pieces of the same furniture are separate: each has its own settings and its own source.
_Avoid_: instance, object, item

**Source**:
What holds the content a piece shows: a PC's shell, a board of tasks, the debriefs of a Directory. A piece points at a source and several pieces may point at the same one; removing a piece never removes its source's content.
_Avoid_: backend, store, data

**Program**:
The code a piece of interactive furniture ships with, beside its art. Optional: reactions simple enough to state as rules need none. A program that did not ship with Pixel Agents runs only after the user approved it, and is asked about again when it changes.
_Avoid_: plugin (also avoided for providers), extension, behaviour, script

**Panel**:
The interface a piece opens for the user: a terminal, a board, a review screen. Furniture without a panel can still be hovered, but offers nothing to click.
_Avoid_: card (that's an agent's), window, dialog

**Furniture label**:
The small box over a hovered piece naming it and showing whatever the furniture chose to say, with a faint outline round the piece: the furniture's counterpart of an agent's activity label.
_Avoid_: card, tooltip

**Push**:
A message from outside Pixel Agents arriving at one piece, at an address that belongs to that piece alone.
_Avoid_: webhook (the sender's word for it), hook (that's a provider's), notification

**PC shell**:
The plain terminal on the host that a PC opens for the user, in a Directory of the Area the PC stands in. It has a card in the card bar like an agent's, the PC's screen is on for as long as it lives, and closing its card ends it. A PC with a live shell opens that shell; otherwise a PC an agent works at opens that agent's terminal. Agents are seated elsewhere while a PC's shell lives, where they can be.
_Avoid_: user terminal, console, SSH session

## Activity Detection

**Hook**:
A push notification an AI tool sends about its own session activity, delivered to Pixel Agents as it happens.

**Transcript**:
The append-only record of a session. Read in both detection modes for tool content.
_Avoid_: JSONL (Claude's file format, not the concept), log

**Hooks mode**:
The preferred detection mode, in which agent status is driven by hooks.

**Heuristic mode**:
The fallback detection mode, in which agent status is inferred from transcript activity, timers, and silence.
_Avoid_: file fallback, transcript mode, polling mode

## Integration Boundary

**Provider**:
The integration that connects one coding-agent CLI — Claude Code, Codex, Pi, Antigravity, OpenClaw, and the like — to Pixel Agents. A provider normalizes its CLI's raw activity into agent events and knows how to install that CLI's hooks. One provider per CLI; Claude Code is the reference implementation.
_Avoid_: plugin, connector

**Agent event**:
The canonical, CLI-agnostic description of something happening in a session: a tool started, a turn ended, a teammate went idle. Providers produce agent events; everything downstream consumes only these, never CLI-specific names.
_Avoid_: hook event (the raw, CLI-specific payload before a provider normalizes it)

**Runtime**:
The adapter-independent core that tracks agents and drives the office. It is a separate thing from the adapters that compose it, the providers that feed it, and the office UI it serves.
_Avoid_: server, backend

**Transport**:
The channel carrying protocol messages between the office UI and the runtime. The protocol is identical on every adapter; only the wire differs.
_Avoid_: connection, socket

**Protocol**:
The message contract between the office UI and the runtime, shared by every adapter and defined in a single source of truth.
_Avoid_: API

**Pixel Office MCP**:
The office's MCP server, offered to the agents the office launches once the user consents: through it an agent can see the office, edit its layout, visit spots, and launch, close and message other agents. Full name "Pixel Agents Office MCP"; never just "Office MCP", which reads as Microsoft Office.
_Avoid_: Office MCP, office tools, agent powers
