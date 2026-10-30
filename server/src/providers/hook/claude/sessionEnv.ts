/**
 * The variables a running Claude Code session exports to everything under it
 * to say "you are inside session X": its id, its pid, its messaging socket and
 * token, its entrypoint, and the child-session flag that makes a nested CLI
 * turn transcript saving off. An agent the office launches is a session of its
 * own, so a server started from inside a session must not hand them on.
 *
 * Named one by one (plus the two families that are all per-session) rather than
 * every `CLAUDE_CODE_*`: most of that prefix is configuration the user exported
 * on purpose (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_OAUTH_TOKEN`, …), which
 * a launched agent must keep.
 */
const SESSION_MARKERS: ReadonlySet<string> = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_CHILD_SESSION',
]);

/** Prefixes whose every variable belongs to one session (`CLAUDE_CODE_SESSION_ID`,
 *  `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_MESSAGING_SOCKET`, …). */
const SESSION_MARKER_PREFIXES: readonly string[] = [
  'CLAUDE_CODE_SESSION_',
  'CLAUDE_CODE_MESSAGING_',
];

export function isInheritedClaudeSessionEnv(name: string): boolean {
  return (
    SESSION_MARKERS.has(name) || SESSION_MARKER_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}
