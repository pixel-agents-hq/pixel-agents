# Interactive furniture may ship code, which runs apart from the office and only once approved

Furniture used to be art plus placement rules; what a PC does when an agent works at it was
written into the office. **Interactive furniture** moves that to the furniture: it declares how
it reacts to agents, what the user can do with it, and whether it accepts **pushes** from
outside. Third parties must be able to add furniture the office has never heard of (a board
linked to a tracker, a TV of reviews), so a furniture folder may ship a **program**, not only
data. A manifest that only picks among behaviours built into Pixel Agents was the safer choice
and was rejected: every new kind of furniture would need a release.

That code runs on a host with shells and agents on it, so three rules contain it.

## A program runs only after the user approved its folder

Furniture bundled with Pixel Agents runs as shipped. Furniture from anywhere else shows as plain
furniture until an office's privileged connection approves that folder's program, after a
disclosure of what it ships and what it asks for. A folder that changes is asked about again.
Agents can never approve one. Treating "added the asset directory" as the consent was rejected:
one click would trust every file that folder ever holds.

## Its host side is a process of its own, with a narrow contract

A program's host side runs in its own process and speaks to the office in messages: it is told
of the agent events it declared, of pushes and of the user's actions, and it asks the office for
animations, label text, visits and storage. It holds none of the office's tokens, and a crash or
a hang cannot take the office down. Importing it into the server was rejected for both reasons.
This is not a sandbox: an approved program is still code running as the user, which is why the
approval exists.

## Its user side is a sandboxed frame; the office keeps what only it can do safely

A **panel** a program draws is its own page in a sandboxed frame inside a surface the office
draws, talking over a small bridge. It never sees the office token. Importing it into the office
app was rejected: it would act with the office's full power in every open office. What needs
that power is a panel the office provides and furniture asks for by name; the terminal is the
first.

## Rules first, code only where rules run out

Reactions an office can evaluate itself are rules in the manifest ("while an agent works at my
seat, play on"), so the bundled PC needs no program for its agent side and nothing waits on a
message round trip per frame. A program subscribes to agent events only when it needs logic.

## Programs see as little of the agents as they can do with

A program receives event kinds, tool names and statuses, for the kinds it declared. Tool inputs
and transcript text are not handed over; each further piece of agent data is added as a named
extra when a real piece of furniture needs it, listed in the approval's disclosure.

## Furniture mostly watches; agents act on it through two generic tools

Furniture reacts to what agents already do. For what watching cannot express, the Pixel Office
MCP gets one tool that lists the pieces agents can use with their actions, and one that performs
an action on a piece. Letting each program add its own tools was rejected: the tool list would
change with the layout, and third-party text would land in every agent's context.

## Agents reach PC shells through the Pixel Office MCP (amended)

A PC shell was first the user's alone: the Pixel Office MCP neither listed, read nor typed into
one. That was reversed because the owner wants agents to set up terminals he can watch, not only
background ones hidden from him. So, under the MCP's existing consent and on standalone only
(where the office can read and write its terminals), agents get five tools of the office's own:
list the shells and the PCs that open one, open a shell at a PC, read it, type into it (text or
keys, Ctrl+C and Ctrl+D included) and close it. They drive the same registry an office's clicks
do, so the user sees the shell as any other: its card, its lit PC, its terminal a click away. The
changing ones are refused while the MCP is read-only, and the tutorial pre-approves none of them,
reading included, since a shell's screen can hold secrets. These are not the two generic piece
tools above: the terminal is a panel the office provides, so its tools belong to the office like
launch_agent, and their text never comes from a program. The agents' own terminal tools still
never address a shell.

The accepted cost: an agent running in a restricted permission mode gains a path to run commands
on the host that Claude Code's per-tool MCP prompt is the only gate on. A shell is a plain login
shell, not a sandbox, and nothing in the office inspects what is typed into it.

## State belongs to a source, not to a piece

A **piece** holds settings and points at a **source** that holds the content. Two pieces may show
one source, and removing a piece never removes content. Content owned by the piece was rejected
(deleting a TV would delete its tapes), as was content owned by the kind of furniture (no board
per project).

## A push has an address per piece

Each piece that accepts pushes has its own address carrying a random secret, shown and rotatable
in its settings. The office's own token was rejected: it cannot be given to an outside service.
Making that address reachable from outside the host's network is the user's step.
