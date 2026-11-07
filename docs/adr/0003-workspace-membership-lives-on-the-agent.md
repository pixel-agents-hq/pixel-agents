# Workspace membership lives on the agent and is decided once, never derived on read

A workspace groups Directories (CONTEXT.md), but an agent's workspace is stored on the agent
(`workspaceId`), not recomputed from its Directory each time the office is drawn.

Why stored, not derived: Directories can be reassigned between workspaces at any time, and a
reassignment must not move characters that are already working. Deriving on read would make every
reassignment silently relocate live agents and fire no event the UI could explain.

Consequences that follow from storing it:

- `launchAgent` carries no workspace field. The workspace is the one the `directoryPath` belongs to,
  so there is never a second source that could disagree with the first. An unclaimed or unknown
  directory path lands in the default workspace instead of being rejected, matching how
  `launchAgent` already treats unknown paths.
- An adopted session has no Directory to read, only a working directory. Detection can run before
  that working directory is known (a transcript still empty when the scanner adopts it), so the
  agent starts in the default workspace and the first working directory to arrive settles it,
  once. After that only two things move an agent: its lead's workspace changing, and its workspace
  being removed.
- A teammate follows its lead: once linked, its workspace is its lead's and a working directory of
  its own no longer decides anything.
- Persisted agents without a `workspaceId`, or with one that no longer exists, load into the
  default workspace. Roll-back needs nothing but deleting `workspaces.json`: the old version
  ignores the field and shows one office.
- The "working directory not yet known" mark is not persisted. An agent restored after a restart
  keeps the workspace it had and is not settled again.
