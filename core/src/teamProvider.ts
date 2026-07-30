/**
 * TeamProvider: optional extension on HookProvider for CLIs that support the
 * Lead + Teammates pattern (Claude Agent Teams today; hypothetical future CLIs).
 *
 * Semantic-level interface: the host asks *what* (who's on this team? what
 * metadata does this session have?) rather than *how* (what's the sidecar file
 * path? what's the JSON field name?). Providers choose their own storage
 * (filesystem, API, database) and expose only the queries.
 *
 * Providers without team support simply don't set `HookProvider.team`. No team-
 * gated code runs for them -- no stubs, no dead branches.
 */
export interface TeamProvider {
  /** CLI identifier (e.g. 'claude', 'codex'). Used for logging. */
  providerId: string;

  /** Tool names that CAN spawn persistent teammates (fast-path gate only).
   *  Claude: 'Agent'. But note: the same tool can also spawn basic subagents, so use
   *  `isTeammateSpawnCall(toolName, toolInput)` for the authoritative decision. */
  teammateSpawnTools: ReadonlySet<string>;

  /** Tool names that spawn within-turn, ephemeral subagents tied to a parent tool call.
   *  Claude: 'Task'. These produce negative-ID sub-agent characters in the webview. */
  withinTurnSubagentTools: ReadonlySet<string>;

  /** Authoritative predicate: does THIS SPECIFIC tool call spawn a persistent teammate?
   *  Depends on tool input flags, not just the tool name. Without this, we can't
   *  distinguish basic subagents from teammates when the same tool name is reused.
   *
   *  Claude: `Agent` tool with `run_in_background: true`. */
  isTeammateSpawnCall(toolName: string, toolInput: Record<string, unknown>): boolean;

  /** Extract a teammate's identity (name) from a raw hook event payload (pre-normalization).
   *  Used to route TeammateIdle / TaskCompleted hooks to the specific teammate agent.
   *  Claude: prefers `teammate_name`, with `agent_type` kept for SubagentStart compatibility. */
  extractTeammateNameFromEvent(event: Record<string, unknown>): string | undefined;

  /** Find all teammate transcripts belonging to a given lead session.
   *  Provider chooses how to discover them (filesystem scan, API call, cache).
   *  The returned `jsonlPath` is an opaque transcript handle the caller hands
   *  back to adoption code; the `teammateName` identifies which team member it is.
   *
   *  `teamName` (when the lead's team is known) lets the provider also find
   *  teammates that run as independent top-level sessions tagged with the team
   *  rather than living under the lead session's own directory. Entries for such
   *  teammates carry their own `sessionId` so the host can route their hook
   *  events directly; entries without one share the lead's session.
   *
   *  Sidecar-backed entries additionally expose `toolUseId` (the lead's spawn
   *  tool_use id), `description`, and `name` when the CLI records them. The host
   *  uses toolUseId to match background spawns (teams OFF) to the lead's live
   *  spawn tools, and `name` as the classifier: a named spawn is a Teammate, an
   *  unnamed one is a Sub-agent (see CONTEXT.md — name is the sole distinction). */
  discoverTeammates(
    projectDir: string,
    leadSessionId: string,
    teamName?: string,
  ): Array<{
    jsonlPath: string;
    teammateName: string;
    sessionId?: string;
    toolUseId?: string;
    description?: string;
    name?: string;
  }>;

  /** Detect a teammate spawn from a completed spawn-tool result on the LEAD's
   *  transcript. Some CLI versions never tag the lead's own records with team
   *  metadata; the only lead-side evidence of the team is the spawn tool's
   *  result (Claude: `agent_id: <name>@<team>` in the Agent tool_result).
   *  Returns the spawned teammate's identity, or null when the result is not a
   *  teammate spawn. `resultContent` is the raw tool_result content (string or
   *  content-block array). */
  extractTeammateSpawnFromToolResult?(
    toolName: string,
    resultContent: unknown,
  ): { teamName: string; teammateName: string } | null;

  /** Return team metadata for a session if it participates in a team.
   *  Provider decides where to look (sidecar file, JSONL header, DB, etc.).
   *  Returns null if the session is not part of a team.
   *  agentName is undefined for the lead and set to the teammate's name for a teammate. */
  getTeamMetadataForSession(jsonlPath: string): { teamName: string; agentName?: string } | null;

  /** Extract team metadata from a transcript record (one parsed JSONL line).
   *  In-memory counterpart to getTeamMetadataForSession; used by transcriptParser
   *  where it already has the parsed record and shouldn't re-open the file. */
  extractTeamMetadataFromRecord(
    record: Record<string, unknown>,
  ): { teamName?: string; agentName?: string } | null;

  /** Get the currently-active member names of a team. Source of truth for team membership.
   *  Returns the Set of names, or null if the team can't be read (team dissolved / no data).
   *  Members the CLI has marked as finished (Claude: `isActive: false`) are excluded, so
   *  completed one-shot teammates despawn via the periodic config scan.
   *
   *  Claude reads `~/.claude/teams/<teamName>/config.json`'s `members[].name` array.
   *  Providers using API-driven team stores implement without a file path. */
  getTeamMembers(teamName: string): Set<string> | null;
}
