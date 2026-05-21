/**
 * Normalize a workspace path into a directory name used for per-project state.
 *
 * Matches Claude's convention at ~/.claude/projects/<name>/ where every
 * non-alphanumeric character (except '-') is replaced with '-'. Keeps the
 * hash deterministic across platforms so the standalone server and Claude
 * find the same project dir for a given absolute path.
 */
export function normalizeProjectPath(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9-]/g, '-');
}
