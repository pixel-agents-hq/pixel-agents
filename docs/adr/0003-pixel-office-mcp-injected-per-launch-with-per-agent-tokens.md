# The Pixel Office MCP is injected per launch with per-agent tokens, never installed

The Pixel Office MCP lets agents see and change the office: edit its layout, launch, close and
type into other agents' terminals. Something has to tell Claude Code where the server is and
prove to the server who is calling. We hand it over at launch: with the user's consent, every
launch and resume through the office's one launch path adds `--mcp-config <file>` to the CLI.
The file, 0600 under `~/.pixel-agents/mcp/<server>/`, holds the `/mcp` URL and a random token
minted for that agent alone. The token lives only in the server's memory and is the caller's
whole identity: it dies with the agent, with the server process, and all at once when the
feature is turned off. Nothing is written to `~/.claude`.

## Rejected: a user-scope install

`claude mcp add --scope user` (or the same entry written into `~/.claude.json`) is how MCP
servers are usually added, and it would also reach sessions started outside the office. That is
the problem. It edits the user's Claude configuration — the thing the hooks consent work
(`docs/adr/0001`) goes to such lengths to touch only with consent and to undo exactly — and it
outlives the office: a server that is stopped, crashed or uninstalled leaves an entry every
session keeps trying. Worse, it gives every session the same credential, so the office could not
tell agents apart, and an agent it never launched (with no terminal of ours to message or close)
would get the power to launch and type into the ones it did. Reaching sessions started elsewhere
is out of scope until it can be done without those costs.

## Rejected: reusing the server token

The office already has a secret, the server token that makes a `/ws` connection privileged.
Giving it to agents would have needed no registry. But anything an agent runs — a build script,
a dependency's postinstall, a prompt-injected command — can read its environment and files, and
with the server token it could do everything the office's own UI can: grant hook consent,
rewrite settings, launch shells. It would also leave no identity, so "act on the caller unless
told otherwise" would be impossible. A per-agent token can do only what the MCP's tools allow,
names exactly one agent, and stops working when that agent leaves.

## Consequences

- Only agents the office launched or resumed get the MCP; adopted and external sessions never
  do. Claude Code's own MCP permission prompts still apply on top.
- The token never appears on a command line (`ps` would show it), only in the file.
- Tokens don't survive a server restart. Agents kept alive by `--pty-host` lose access until they
  are resumed through the office.
- Consent follows `docs/adr/0001`: a tri-state record, one config write per answer, Back
  revises, unanswered means not injected; a decline revokes every running agent at once.
- The launch command is the provider's (`buildLaunchCommand`'s `mcpConfig`), so the runtime stays
  CLI-agnostic; today only Claude's knows the flag.
- Hard to reverse: moving to an install later means migrating users' Claude configs, and moving
  to a shared credential means giving up per-agent identity in every tool.
