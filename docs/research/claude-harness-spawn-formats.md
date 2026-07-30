# Claude Code harness: sub-agent and teammate spawn formats

Research note investigating two claims about how the current Claude Code CLI spawns
sub-agents and teammates, and what it writes to disk. Relevant to this repo because
`server/src/providers/hook/claude/` and the transcript-fallback parser key off these
formats.

**Investigated:** 2026-07-29
**CLI under test:** `claude --version` → `2.1.220 (Claude Code)`
(binary at `/Users/pablo/.local/share/claude/versions/2.1.220`)
**Evidence base:** official docs, the official changelog, the installed binary, and a
machine-wide sweep of every JSONL transcript under `~/.claude/projects/` — 939 files
across 46 project directories, spanning 30 distinct CLI versions (2.1.170 – 2.1.220)
and content dates 2026-06-10 to 2026-07-29.

Web-sourced and machine-local evidence are kept in separate sections so each can be
judged on its own. The two claims below are argued mainly from docs, changelog and
controlled probes; the [Local empirical evidence](#local-empirical-evidence) section is
the independent corpus sweep.

---

## Claim 1

> The current Claude Code harness has no Task tool anymore; the Agent tool replaced it.
> Only an older CLI can produce within-turn Task sub-agent records — `progress` records
> with `data.type: "agent_progress"` in the session JSONL.

**Verdict: confirmed**, with one correction on the tool name and one on where
`agent_progress` lives.

### 1a — Task vs Agent

The rename is documented explicitly:

> "In version 2.1.63, the Task tool was renamed to Agent. Existing `Task(...)`
> references in settings and agent definitions still work as aliases."
> — <https://code.claude.com/docs/en/sub-agents>

So the tool exposed to the model for spawning sub-agents is `Agent`. The correction to
the claim: the name `Task` is **not fully gone** — it survives as an alias in
permission rules and agent-definition `tools:` frontmatter. Both syntaxes were
introduced while the tool was still called `Task`, and the 2.1.63 rename kept them
working:

- `Task(AgentName)` in `settings.json` permissions / `--disallowedTools` (changelog v2.1.0)
- `Task(agent_type)` in agent `tools` frontmatter (changelog v2.1.33)

The changelog also still refers to "the Task tool" by its historical name well after the
rename — e.g. v2.1.212: _"Deprecated the Task tool's `mode` parameter (now ignored);
subagents inherit the parent session's permission mode by default"_. That is prose, not
evidence of a live tool named `Task`.

Empirical confirmation across all local transcripts (counts as of the full sweep below;
they drift upward as sessions run):

```
$ grep -rl '"name":"Task"'  ~/.claude/projects --include='*.jsonl' | wc -l
0
$ grep -rl '"name":"Agent"' ~/.claude/projects --include='*.jsonl' | wc -l
98
```

No transcript written by 2.1.170 or later contains a `Task` tool_use. The rename at
2.1.63 predates every transcript retained on this machine, so the cutover cannot be
dated locally — it is dated from the docs.

### 1b — `agent_progress` records in session JSONL

Confirmed: **the current CLI does not write `agent_progress` records into session
JSONL.** Not for background sub-agents, and — contrary to what one might assume —
not for foreground ones either.

Machine-wide, zero genuine records exist:

```
$ grep -rl '"type":"agent_progress"' ~/.claude/projects --include='*.jsonl' | wc -l
0
$ grep -rho '"type":"[a-z_]*progress[a-z_]*"' ~/.claude/projects --include='*.jsonl' | sort -u
(no output — no progress records of any kind)
```

A plain `grep -rl 'agent_progress'` returns 28 files, but every hit is prose: the string
appears escaped (`\"agent_progress\"`) inside conversation content, because this repo's
`CLAUDE.md` and a memory file discuss it. Those are not records. The quoted-form grep
above is the one that discriminates.

Three controlled probes were run against 2.1.220 to rule out "we just never hit the
code path":

| Probe                  | Setup                                                                                                        | `agent_progress` in session JSONL | on stream-json stdout                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------- | ------------------------------------ |
| Foreground sub-agent   | `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, `run_in_background=false`, `--output-format stream-json --verbose` | 0                                 | 0                                    |
| Same + forwarding      | as above plus `--forward-subagent-text`                                                                      | 0                                 | 0 (and 0 `"type":"progress"` events) |
| Named background spawn | `--teammate-mode in-process`, `run_in_background=true`                                                       | 0                                 | n/a                                  |

Probe transcripts: `~/.claude/projects/-private-tmp-…-scratchpad-probe-stream/`,
`…-probe-fwd/`, `…-probe-bg/` (all stamped `"version":"2.1.220"`).

Instead of progress records, every sub-agent gets its own transcript file. This is the
documented behaviour:

> "find IDs in the transcript files at `~/.claude/projects/{project}/{sessionId}/subagents/`.
> Each transcript is stored as `agent-{agentId}.jsonl`." … "when the main conversation
> compacts, subagent transcripts are unaffected. They're stored in separate files."
> — <https://code.claude.com/docs/en/sub-agents>

Confirmed on disk: 64 `subagents/` directories and 147 sidecars machine-wide, the oldest
stamped `"version":"2.1.170"` (2026-06-10). Full breakdown in
[Local empirical evidence](#local-empirical-evidence).

In the `--forward-subagent-text` probe the sub-agent did real work — its transcript
records one `Bash` tool_use with no permission denial — so the zero result is not an
artefact of the sub-agent never getting started.

**Caveat on the "older CLI only" half of the claim.** The 2.1.220 binary still contains
live code that _constructs_ `agent_progress` objects — `strings` on the binary yields 18
occurrences, including a writer whose failure path logs `bg-subagent progress write
failed`, and a `forked-command-${name}` emitter. So the record type is not dead code
that was deleted; it exists on an in-process/streaming channel. What is established
empirically is narrower and is what matters for a transcript parser: **it is never
persisted to session JSONL by any version from 2.1.170 onward**, and it did not appear
on stream-json stdout in either probe. Whether some other flag combination surfaces it
on the stream was not exhaustively determined.

**Dating is approximate.** The oldest transcript on this machine is v2.1.170
(2026-06-10), and it already uses the `subagents/` file layout with no progress records.
The transition therefore happened at or before 2.1.170 and cannot be pinned down from
local evidence. The most likely anchor from the changelog is the shift of sub-agents to
their own transcript files, which is already in force by 2.1.170; the separate change
making sub-agents _background by default_ landed later, at v2.1.198 (see timeline).

---

## Claim 2

> The old "inline teammate" format — a named `Agent(run_in_background: true)` spawn with
> agent teams, writing the teammate transcript under the lead session's own directory
> `<projectDir>/<leadSessionId>/subagents/` — is no longer producible. On the current CLI
> a NAMED Agent spawn always creates an independent top-level session […]

**Verdict: partially confirmed — the description of the new format is accurate, but the
words "always" and "no longer producible" are refuted.**

The `<leadSessionId>/subagents/` layout is still produced by 2.1.220 for named
background Agent spawns. What determines which layout you get is whether the spawn
actually becomes a registered _team teammate_, not the CLI version.

### The described "new" format is real and current

Verified against this very session. The researcher agent that produced this document was
spawned as a named teammate, and its transcript is a top-level UUID session:

```
$ ls ~/.claude/projects/-Users-pablo-Desktop-pixels-pixel-agents/39fff716-….jsonl
$ grep -o '"teamName":"[^"]*"'  39fff716-….jsonl | sort -u   → "teamName":"session-1b296605"
$ grep -o '"agentName":"[^"]*"' 39fff716-….jsonl | sort -u   → "agentName":"harness-researcher"
$ grep -o '"version":"[0-9.]*"' 39fff716-….jsonl | sort -u   → "version":"2.1.220"
```

The implicit team config exists at `~/.claude/teams/session-1b296605/config.json`, and
its `leadSessionId` (`1b296605-7ae3-4623-a5ab-7944a1603e3d`) matches **no** transcript on
disk — confirming the existing note in this repo's `CLAUDE.md` that leads must not be
linked by that field. The lead's own transcript
(`d41e8bfa-ad2e-446f-9754-84e0743043c6.jsonl`) carries a spawn tool_result reading
`agent_id: fixture-teammate@session-1b296605` and carries **no** `teamName`/`agentName`
tags itself (`grep -c` → 0 for both).

The `session-<8hex>` naming is documented:

> "Teams and tasks are stored locally under a session-derived name. The name is
> `session-` followed by the first eight characters of the session ID: Team config:
> `~/.claude/teams/{team-name}/config.json`"
> — <https://code.claude.com/docs/en/agent-teams>

The unnamed-spawn format is also confirmed. Both sidecars in the lead's `subagents/` dir
carry exactly the fields the claim describes:

```json
{
  "agentType": "general-purpose",
  "description": "Foreground sub-agent fixture (B)",
  "toolUseId": "toolu_01JAsN89upg4q4cp9itv3mCd",
  "spawnDepth": 1,
  "model": "sonnet"
}
```

Note this sidecar is from a **foreground** spawn — the lead transcript records
`"run_in_background":false` for it. So the `subagents/` layout is not background-specific;
it is where all sub-agent transcripts go.

### What refutes the claim

First, `teammateMode` still accepts `in-process`, and the installed CLI says so itself.
Asking for an invalid value makes it print its own enum:

```
$ claude --teammate-mode nonsense-value -p hi
error: option '--teammate-mode <mode>' argument 'nonsense-value' is invalid.
       Allowed choices are auto, tmux, iterm2, in-process.
```

The docs confirm `in-process` is not merely accepted but is the **default**:

> "The default is `"in-process"`. Before v2.1.179 the default was `"auto"` […] To override
> the default, set `teammateMode` in `~/.claude/settings.json` […] To set the mode for a
> single session, pass it as a flag: `claude --teammate-mode auto`. The `--teammate-mode`
> flag is experimental and doesn't appear in `claude --help`."
> — <https://code.claude.com/docs/en/agent-teams>

A direct experiment on 2.1.220 produced the old inline layout. In an isolated working
directory, with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and `--teammate-mode in-process`,
a **named** Agent spawn with **`run_in_background=true`** (verified in the lead transcript:
`grep -o '"run_in_background":[a-z]*'` → `1 "run_in_background":true`) wrote:

```
…-scratchpad-probe-bg/98ce7d00-dae9-493d-a167-d88972c9a74c.jsonl          ← lead
…-scratchpad-probe-bg/98ce7d00-…/subagents/agent-a4aa8ed701f305423.jsonl  ← the named agent
…-scratchpad-probe-bg/98ce7d00-…/subagents/agent-a4aa8ed701f305423.meta.json
```

with the sidecar carrying the name:

```json
{
  "agentType": "general-purpose",
  "description": "Spawn probemate2 test agent",
  "name": "probemate2",
  "toolUseId": "toolu_01W2Uk84YaqswF5Sbm2NU2ZT",
  "spawnDepth": 1
}
```

and **no** separate top-level UUID session in that project dir. So a named,
backgrounded Agent spawn on the current CLI can and does write under
`<projectDir>/<leadSessionId>/subagents/`. "No longer producible" is false, and "a NAMED
Agent spawn _always_ creates an independent top-level session" is false.

An identical probe run with `--teammate-mode tmux` instead of `in-process` produced the
**same** result — `probe-tmux/eb35b74a-…/subagents/agent-a474cd2000e1f6177.jsonl`, again
with `"run_in_background":true` and no top-level teammate session. So `teammateMode` was
_not_ the deciding factor in these runs.

### Important qualification — what the probes do and do not show

In neither probe did a team actually form. For the `in-process` run: no
`~/.claude/teams/session-98ce7d00/` directory appeared during a 2-second-interval poll
across the whole run, no `~/.claude/tasks/session-98ce7d00/`, the agent transcript carried
no `teamName`/`agentName` tags (`grep -c` → 0), and the spawn tool_result read
`Async agent launched successfully.` rather than `agent_id: <name>@<team>`. The `tmux`
run behaved the same way. Both were non-interactive (`-p`), and that — not the teammate
mode — is the most likely reason team initialisation never happened.

So what the probes strictly establish is:

- A **named background sub-agent** that does not become a team teammate lands in
  `<leadSessionId>/subagents/` with a `name`-bearing sidecar, on 2.1.220. This alone
  refutes "always creates an independent top-level session".
- They do **not** establish where a fully team-registered _in-process teammate_ writes
  its transcript. That case could not be produced non-interactively, and no instance of
  it exists locally (see below).

On the unresolved case, two indirect signals point toward the inline location: the docs
describe in-process teammates as running "inside your main terminal" as part of the lead
process, and the binary's transcript-path builder resolves sub-agent transcripts to
`<projectDir>/<currentSessionId>/subagents/agent-<id>.jsonl` with no team-specific branch.
Neither is proof. Confirming it would need an interactive session with
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and `teammateMode: "in-process"`, driven through
a pty.

For a transcript-parsing consumer such as this repo the practical upshot is unaffected:
the `<leadSessionId>/subagents/` layout is still emitted by the current CLI and must
still be handled.

### Why this machine only shows the top-level format for teammates

Every teammate ever recorded locally used the tmux backend, which is why the inline form
looks extinct here. Across all 31 local team configs:

```
backendType=in-process, role=lead:      30
backendType=tmux,       role=teammate:  17
backendType=in-process, role=teammate:   0
```

The lead is always `in-process` (it _is_ the main process); every teammate on this machine
was spawned into a tmux pane, so each became an independent top-level session. Note this
is despite `in-process` being the documented default since 2.1.179 — something in the
local setup (the harness that launches these sessions) selects the tmux backend. That is
a property of the local configuration, not of the CLI version. See
[Local empirical evidence](#local-empirical-evidence) for the full config sweep.

---

## Local empirical evidence

An independent sweep of every transcript, sidecar and team config on this machine, run
separately from the web sources above. Where it agrees with the docs it is corroboration;
where it goes further (the organic-frequency findings) it is evidence the docs do not
provide.

### Corpus

| Property                           | Value                              |
| ---------------------------------- | ---------------------------------- |
| JSONL transcripts                  | 939                                |
| Project directories                | 46                                 |
| Distinct CLI versions              | 30 (2.1.170 … 2.1.220)             |
| Content-timestamp span             | 2026-06-10 → 2026-07-29 (~7 weeks) |
| `subagents/` directories           | 64                                 |
| `.meta.json` sidecars              | 147                                |
| Team configs in `~/.claude/teams/` | 31                                 |

Version coverage is dense rather than sparse — every version from 2.1.197 onward is
represented, so the recent window is well sampled:

```
2.1.170    4 files  2026-06-10        2.1.204   28  2026-07-06..07-14
2.1.181    1        2026-06-18        2.1.205    4  2026-07-09..07-12
2.1.185    1        2026-06-22        2.1.206   21  2026-07-09..07-10
2.1.187   15        2026-06-24        2.1.207   69  2026-07-08..07-14
2.1.190    2        2026-06-24        2.1.209   26  2026-07-11..07-15
2.1.191    4        2026-06-22..07-03 2.1.210   13  2026-07-15..07-20
2.1.193    1        2026-06-22        2.1.211   25  2026-07-12..07-18
2.1.195    2        2026-06-22..06-30 2.1.212    5  2026-07-17..07-18
2.1.197    1        2026-07-02        2.1.214   28  2026-07-18..07-19
2.1.198    1        2026-07-02        2.1.215  110  2026-07-15..07-23
2.1.199   25        2026-07-02..07-06 2.1.216   56  2026-07-20..07-21
2.1.200   29        2026-07-03..07-04 2.1.217   32  2026-07-21..07-24
2.1.201  272        2026-06-25..07-10 2.1.218   19  2026-07-23..07-24
2.1.202   11        2026-07-03..07-08 2.1.219    4  2026-07-21..07-24
2.1.203    1        2026-07-08        2.1.220  150  2026-07-21..07-29
```

**Retention caveat.** Claude Code deletes transcripts after `cleanupPeriodDays` (30 by
default), so this corpus is a rolling ~7-week window, not the full history of the machine.
Anything that stopped happening before 2026-06-10 leaves no trace here. That is the single
biggest limit on what these numbers can date.

### Claim 1 — `agent_progress` and the Task tool

Every form of the search returns nothing:

| Query                                                     | Files matched |
| --------------------------------------------------------- | ------------- |
| `grep -l '"agent_progress"' ~/.claude/projects/*/*.jsonl` | **0**         |
| same, recursive (incl. `subagents/`)                      | **0**         |
| `grep -rl '"type":"agent_progress"'`                      | **0**         |
| `grep -rl '"name":"Task"'`                                | **0**         |
| `grep -rl '"name": "Task"'` (space variant)               | **0**         |
| `grep -rl '"name":"Agent"'` (control)                     | **98**        |
| bare word `agent_progress`                                | 27            |

The 27 bare-word hits are **prose, not records**. The string occurs escaped
(`\"agent_progress\"`) inside conversation content, because this repo's `CLAUDE.md` and a
memory file discuss the format. The quoted-form greps are the ones that discriminate, and
they return zero. This is the trap the sweep was designed to catch: a naive
`grep -rl agent_progress` would have "found" 27 files and inverted the conclusion.

A per-file pass over all 939 transcripts (recording `grep -c` for both patterns) confirms
it file by file: **0 transcripts with `agent_progress` > 0, 0 with `Task` tool_use > 0.**

Newest 10 transcripts by mtime — all `2026-07-29`, all `"version":"2.1.220"`:

```
2026-07-29 20:07 | ap=0 task=0 agent=4 | d41e8bfa-….jsonl   (lead)
2026-07-29 20:07 | ap=0 task=0 agent=1 | 15cbecf8-….jsonl
2026-07-29 20:07 | ap=0 task=0 agent=0 | 39fff716-….jsonl   (this session)
2026-07-29 20:07 | ap=0 task=0 agent=0 | subagents/agent-ab1116a554b6317b7.jsonl
… (remaining 6 identical: ap=0 task=0)
```

Oldest 10 by mtime — `2026-06-10` / `2026-06-24`, versions `2.1.170` / `2.1.187`,
also all `ap=0 task=0`, and already using the `subagents/agent-*.jsonl` layout.

**Result: there is no "newest version that still wrote `agent_progress`" on this machine —
the format is absent from the entire retained corpus.** The same holds for the `Task` tool
name. Both therefore died at or before **v2.1.170 / 2026-06-10**, which is an upper bound,
not a date. The local corpus cannot narrow it further; the docs supply the actual rename
date (2.1.63) for the Task→Agent half.

This corroborates the web-sourced conclusion without depending on it: even if the docs
were wrong about the rename version, no transcript written in the last seven weeks
contains either construct.

### Claim 2 — inline teammates vs session teammates

**Sidecar shapes.** All 147 `.meta.json` sidecars were parsed and keyed by field set:

```
 117  agentType, description, spawnDepth, toolUseId
  17  agentType, description, model, spawnDepth, toolUseId
   4  agentType, description, spawnDepth, stoppedByUser, toolUseId
   3  agentType, description, name, spawnDepth, toolUseId
   3  agentType, description, toolUseId
   2  agentType, description, parentAgentId, spawnDepth, stoppedByUser, toolUseId
   1  agentType, description, parentAgentId, spawnDepth, toolUseId
```

**Zero sidecars are missing `toolUseId`** — there is no "old shape" (`agentType`-only)
sidecar anywhere in the corpus. The oldest sidecar (2026-06-10) is already
`agentType + description + toolUseId`; `spawnDepth` appears in everything after it, so
that field is the only shape change visible in this window.

**Named (teammate-shaped) sidecars: 3 — and all three are the synthetic probes created
for this note today** (`probemate`, `probemate2`, `tmuxmate`). In seven weeks of real
usage, **not one organic sub-agent was spawned with a `name` into a `subagents/`
directory.** So the old inline-teammate format is producible (the probes prove that) but
does not occur naturally under this machine's configuration.

**Session-teammate format.** 233 top-level transcripts carry `"agentName"`. Earliest is
**2026-07-03 at v2.1.199**; latest 2026-07-29 at v2.1.220. Distribution of first-seen
version across those 233: 2.1.199 (6), 2.1.200 (19), 2.1.201 (14), 2.1.204 (10),
2.1.206 (4), 2.1.207 (28), 2.1.209 (19), 2.1.210 (2), 2.1.211 (14), 2.1.215 (54),
2.1.217 (17), 2.1.218 (3), 2.1.220 (41).

38 distinct `teamName` values appear across all transcripts, and **every one matches
`session-<8hex>`** — zero named-team tags. The implicit-team naming scheme is the only one
present in the retained window.

**Team configs.** Of 31 entries in `~/.claude/teams/`:

- 30 are implicit `session-<8hex>` teams, earliest surviving `createdAt` **2026-07-15**
  (`session-c45753fc`), latest 2026-07-29.
- 1 is a **named** team, `poem-team`, `createdAt` **2026-04-07** — a pre-2.1.178
  explicitly-created team, older than any retained transcript. Its two teammates
  (`researcher`, `poet`) both used the tmux backend.

The 2026-07-15 date for the first surviving implicit config is _later_ than the
2026-07-03 first tagged teammate transcript. That is not a contradiction: the docs state
the team config directory "is removed when the session ends", so surviving configs are a
biased, incomplete sample. Transcript tags are the more reliable dating signal, and they
put implicit teams in use from at least v2.1.199 / 2026-07-03.

**Backend types**, across all 31 configs:

```
in-process, lead:      30
tmux,       teammate:  17
in-process, teammate:   0
```

Every teammate ever recorded on this machine ran in a tmux pane. The lead is always
`in-process` because it _is_ the main process. Despite `in-process` being the documented
default since 2.1.179, zero in-process teammates exist locally — the harness that launches
these sessions selects tmux.

**Who owns the `subagents/` directories.** Of the 64 `subagents/` dirs, the parent
transcript is team-tagged for **24** of them, untagged for **39** (one parent transcript
had been cleaned up). So the `<sessionId>/subagents/` layout is _not_ a lead-only or
legacy artefact: teammates spawn ordinary sub-agents into their own session directory the
same way leads do. It is the current, universal sub-agent layout.

### What the sweep changes

- **Strengthens Claim 1.** Independent of any web source, neither `agent_progress` nor a
  `Task` tool_use appears in 939 transcripts across 30 CLI versions and 7 weeks.
- **Strengthens the practical reading of Claim 2.** The organic corpus contains zero
  named inline teammates; every real teammate is a tagged top-level session. So the claim
  is right about what you will _observe_ in practice.
- **Does not rescue the claim's absolutes.** "No longer producible" stays refuted — the
  probes produced the layout on 2.1.220. The corpus shows it is unused here, not
  unavailable.
- **Adds a caveat the docs do not.** The `<leadSessionId>/subagents/` path is very much
  alive: 64 directories, 147 sidecars, 24 of them owned by teammates. Any consumer that
  treats that path as legacy will mis-handle current transcripts.

---

## Version timeline

| Version   | Change                                                                                                                                                             | Source                                                     | Dating                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 2.1.63    | `Task` tool renamed to `Agent`; `Task(...)` kept as an alias in settings and agent-definition frontmatter                                                          | docs, sub-agents page                                      | exact                                                                                  |
| ≤ 2.1.170 | Sub-agent transcripts written to `<projectDir>/<sessionId>/subagents/agent-<id>.jsonl` + `.meta.json`; no `agent_progress` records in session JSONL                | oldest local transcript, `"version":"2.1.170"`, 2026-06-10 | **approximate** — upper bound only; the change predates all retained local transcripts |
| 2.1.178   | `TeamCreate`/`TeamDelete` removed; every session gets one implicit team; teammates spawned via the Agent tool's `name` parameter; `team_name` accepted but ignored | changelog v2.1.178; docs agent-teams note                  | exact                                                                                  |
| 2.1.179   | `teammateMode` default changed from `"auto"` to `"in-process"`                                                                                                     | docs, agent-teams page                                     | exact                                                                                  |
| 2.1.186   | `teammateMode: "iterm2"` added                                                                                                                                     | docs, agent-teams page; changelog v2.1.186                 | exact                                                                                  |
| 2.1.198   | Sub-agents run in the **background by default** (previously a gradual rollout)                                                                                     | changelog v2.1.198; docs sub-agents page                   | exact                                                                                  |
| 2.1.212   | Agent/Task tool's `mode` parameter deprecated and ignored                                                                                                          | changelog v2.1.212                                         | exact                                                                                  |
| 2.1.217   | `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` cap (default 20)                                                                                                            | changelog v2.1.217                                         | exact                                                                                  |
| 2.1.220   | Version under test                                                                                                                                                 | `claude --version`                                         | exact                                                                                  |

Nothing in the changelog records a version at which `agent_progress` stopped being
written to session JSONL, and no local transcript is old enough to bracket it. That one
row is the only genuinely undated transition here.

---

## Relevant knobs on the current CLI

| Knob                                       | Effect                                                                                                                                                                                                                                   | Source                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `teammateMode` setting / `--teammate-mode` | `auto \| tmux \| iterm2 \| in-process`; documented as the teammate _display_ mode — split panes vs inside the lead's terminal. Default `in-process` since 2.1.179. Did not change transcript location in the non-interactive probes here | CLI enum error output; docs agent-teams |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`   | Required to enable agent teams at all; "Without that variable, no team is set up at session start, no team directories are written"                                                                                                      | docs agent-teams                        |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`   | Keeps sub-agents synchronous/foreground                                                                                                                                                                                                  | docs sub-agents                         |
| `run_in_background` on the Agent tool      | Per-call background/foreground; `background: true` in agent frontmatter forces background                                                                                                                                                | docs sub-agents                         |
| `--forward-subagent-text`                  | Forwards sub-agent text/thinking into stream-json output; did **not** surface `agent_progress` in testing                                                                                                                                | `claude --help`; probe                  |

---

## Sources

- <https://code.claude.com/docs/en/sub-agents> (redirected from `docs.claude.com/en/docs/claude-code/sub-agents`)
- <https://code.claude.com/docs/en/agent-teams> (redirected from `docs.claude.com/en/docs/claude-code/agent-teams`)
- <https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md>
- Installed CLI `2.1.220` — `claude --version`, `claude --help`, `--teammate-mode` enum error, `strings` on the binary
- Machine-wide sweep of `~/.claude/projects/` (939 transcripts, 46 project dirs,
  30 CLI versions 2.1.170 – 2.1.220, content dates 2026-06-10 – 2026-07-29),
  147 `.meta.json` sidecars, and 31 team configs under `~/.claude/teams/`
- Probe sessions created for this note under a scratchpad working directory
  (`probe-inproc`, `probe-bg`, `probe-stream`, `probe-fwd`, `probe-tmux`), all stamped `"version":"2.1.220"`
