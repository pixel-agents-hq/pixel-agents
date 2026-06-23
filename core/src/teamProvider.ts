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
   *  Claude: reads the `agent_type` field. Returns undefined if not present. */
  extractTeammateNameFromEvent(event: Record<string, unknown>): string | undefined;

  /** Find all teammate transcripts belonging to a given lead session.
   *  Provider chooses how to discover them (filesystem scan, API call, cache).
   *  The returned `jsonlPath` is an opaque transcript handle the caller hands
   *  back to adoption code; the `teammateName` identifies which team member it is. */
  discoverTeammates(
    projectDir: string,
    leadSessionId: string,
  ): Array<{ jsonlPath: string; teammateName: string }>;

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
   *
   *  Claude reads `~/.claude/teams/<teamName>/config.json`'s `members[].name` array.
   *  Providers using API-driven team stores implement without a file path. */
  getTeamMembers(teamName: string): Set<string> | null;
}
