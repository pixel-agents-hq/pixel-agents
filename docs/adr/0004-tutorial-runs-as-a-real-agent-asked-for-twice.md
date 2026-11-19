# The tutorial runs as a real agent, asked for separately, its knowledge served as a tool

The Intro's closing step offers an optional, game-like tutorial. On yes, the greeter walks to a
free seat and sits, and the **Guide** is launched there as a real Claude Code agent that gives the tour as
a conversation in its terminal, through the Pixel Office MCP. That one yes
spends the user's plan and gives an AI session reach into their office, so it is asked for on
its own, apart from the consent step, in the server's words ("Want me to show you around?":
a real session, the plan, auto mode, how to stop it), right on the closing step beside Let's Go.
It was first a separate step after an offer; one step with the terms in full proved enough and
kept the Intro short. Later (2026-11-13) the ask was cut to its headline alone at the
maintainer's call: the terms are still sent (`tutorialStatus.disclosure`) but no longer said.
Nothing launches before `startTutorial`, and only an office's privileged
connection can send it. Let's Go ends the Intro as before.

## The tour is the Guide's conversation, driven by a session-only skill

The tour happens in the Guide's terminal: the Guide tells the user what to do next and answers questions.
The quest checklist only shows progress, and it starts collapsed. The Guide learns how to give the
tour from an **onboarding skill** (`pixel-agents:onboarding`). The office writes a plugin folder
under `~/.pixel-agents/tutorial-plugin/` on every start and passes it with `--plugin-dir`, which
Claude Code loads for that session only. Nothing is installed and nothing touches `~/.claude`,
which keeps the rule in docs/adr/0003.

- **A skill, not a long first message.** The first message rides the CLI's command line (and, in
  VS Code, a shell line typed into a terminal), and it is the first thing the user reads in the
  Guide's terminal, so it is only the skill's command, `/pixel-agents:onboarding`.
  A skill is the form Claude Code gives procedural instructions, and its text lives in the
  server (`tutorialCopy.ts`), written from the build that serves it.
- **The tool keeps a fallback.** `tutorial` status names the skill; with `brief: true` it returns
  the skill's text, for a Claude Code that didn't load the plugin. The MCP server's instructions
  say so, since the first message no longer can.

## Feature knowledge is a tool, not a resource

Agents need to know the office's user-facing features to guide and answer questions. We serve
them from `get_feature_guide` (one topic, or all).

- **A tool, not an MCP resource.** Claude Code lists resources but reads one only when the user
  @-mentions it or the model chooses to; tools are what agents call on their own. Every agent the
  office launches gets the guide, not only the Guide.
- **Text in the server, next to the code.** `server/src/tutorial/featureGuide.ts` is written
  against the code, in CONTEXT.md's words, and changes with the features it describes.

## Only the server marks a quest

A quest completes when the server sees the office change: the office's facts compared with the
ones the run started from — a character in the cast that wasn't there, a new Directory, a new
agent other than the Guide (in any Directory), a layout an office saved differently (an agent's
edit re-baselines it, so it never counts as the user's change).

The quests are four first steps, done in any order: create a character, add a Directory
("Add a project"), launch an agent, change the layout. The Guide opens by saying what Pixel
Agents is and asking whether the user wants to try something in particular or be shown around,
and either way suggests what fits next; the rest (an Area for a Directory, its default
characters, resuming conversations, what agents can do over the MCP) it offers as follow-ups,
untracked. Two earlier shapes were rejected. One led with MCP tricks (sending the Guide for a
walk, having it build): the user should first learn what they can do, then that an agent can do
it for them. The other was eight quests in a fixed order with a "current" one: it read as a
chore list, not an exploration, and its "launch there" and conversations quests only made sense
in sequence.

The user can skip any quest, in the checklist or by asking the Guide, which skips it through the
`tutorial` tool: a skip claims nothing happened, so it is safe to relay. Letting the Guide mark
quests done was rejected: a model saying "done" is not the office seeing it, and the checklist
would tick for things that never happened. An
earlier design also had quests only the office could see (reported by the office) and quests
only the Guide could judge (marked through the `tutorial` tool); none of the four needs either,
so both paths went with them.

## the Guide is never nudged by typing into its terminal

When a quest completes in the office, nobody types into the Guide's terminal to tell it. The user may
be typing there, and a paste would land in their half-written line. The Guide is told to read
`tutorial` status at the start of every turn instead; the panel shows progress the moment it
happens. The cost: the Guide reacts on the user's next message, not instantly.

## The Guide's launch posture is fixed

The Guide always runs in Claude Code's `auto` permission mode, whatever Settings → Skip
Permissions says: safe actions go ahead without a prompt and risky ones still ask, which the ask
says. Chosen over `default`, which stops the tour on a prompt for every small step, and over
skipping permissions, which a session the user has only just met should not get. Its read-only Pixel
Office MCP tools (`tutorial`, `get_feature_guide`, `list_agents`, `get_layout`,
`list_catalog`) are pre-approved for that session (`--allowedTools`, the provider's
`preapprovedMcpTools`), so they never wait on auto mode's judgement either. It launches into the start Directory
(VS Code: the first workspace folder), named in the ask.

## The greeter becomes the Guide in place

On yes, the office walks the greeter to a free seat, sits it, and only then sends
`startTutorial` with that seat. When the Guide joins, that office gives it the greeter's seat
and place without a spawn effect: one character sits down and becomes an agent. Despawning the
greeter and spawning a new the Guide elsewhere was rejected: it read as two characters. The seat is
held while the greeter walks. Other offices see an ordinary join.

## The Guide is named after its character

The Guide wears the greeter's character (the cast's first) and goes by that character's name,
Byte by default, in its copy and its own words, so a renamed character never contradicts its
card. Its Nickname is `Guide`, the role, which stays true after the Tutorial ends: once every
quest is done or skipped, the checklist says so and goes, and the Guide stays as an ordinary
agent closed with its card's × (the checklist never offers to close it; before the end, Quit
still does, asked once).

## Consequences

- A run lives in server memory, exactly as long as its agent's MCP token (docs/adr/0003): a
  server restart, the Guide's terminal closing, or Quit ends it. Quit closes the Guide as its card's ×.
- Both adapters run it. VS Code's terminal launch gained a first message, Nickname, permission
  mode and plugin folder for it, and `launch_agent` and `close_agent` stay standalone-only, so in VS Code the Guide tells the
  user to close it with its card's ×.
- `--plugin-dir` is documented by Claude Code but untried here against a real CLI (tests run the
  mock); the `brief: true` fallback covers a session that didn't load it.
- The tutorial is offered only where the MCP is granted; without it, the Intro ends as before.
