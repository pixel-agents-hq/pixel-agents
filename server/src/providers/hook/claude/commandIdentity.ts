/**
 * Which script a settings.json command runs: the one parser behind every "is
 * this command ours?" check (the hook entries and the status line bridge), so
 * the two can never disagree on what counts as ours. See isOurHookCommand in
 * claudeHookEntries.ts for the identity rules this parser serves.
 */

/** Characters that end a path token in a shell command line. A path we own is
 *  either the whole token or ends at one of these; anything else after it
 *  (`.backup`, `.disabled`, more path segments) means the command names a
 *  DIFFERENT file that merely starts with our path. */
const PATH_TERMINATORS = new Set([' ', '\t', '"', "'", ';', '&', '|', '>', '<', ')']);

/**
 * The ABSOLUTE path of the script a command runs, normalized to forward
 * slashes, or null when the command doesn't look like one of ours.
 *
 * `node "<path>"` and a bare `<path>` are the two shapes we write (and the two
 * a user plausibly hand-edits). A Windows drive prefix (`C:/…`) counts as
 * absolute; a relative path does not: it resolves against whatever directory
 * Claude Code happens to run in, so it names a project-local file that is
 * almost certainly not ours.
 */
export function firstCommandToken(command: string): string | null {
  const trimmed = command.trim();
  // `node <script>` / `node "<script>"` — take the argument. The interpreter
  // itself may be a path (quoted, and on Windows containing spaces).
  const nodeInvocation = /^"?(?:[^"]*[/\\])?node(?:\.exe)?"?\s+(.+)$/.exec(trimmed);
  const raw = nodeInvocation ? nodeInvocation[1] : trimmed;
  const token = readToken(raw.trim());
  if (token === null) return null;
  const normalized = token.replace(/\\/g, '/');
  const absolute = normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized);
  return absolute ? normalized : null;
}

/** Whether a command runs a script whose path ends in one of `suffixes`
 *  (lower case, each starting at a path separator). Case-insensitive: on the
 *  case-insensitive volumes this ships to (macOS, Windows) a differently-cased
 *  path is the same file. */
export function commandRunsScript(command: string, suffixes: readonly string[]): boolean {
  const token = firstCommandToken(command);
  if (token === null) return false;
  const normalized = token.toLowerCase();
  return suffixes.some((suffix) => normalized.endsWith(suffix));
}

/** Read one shell token: a quoted string, or characters up to the first
 *  terminator. Returns null when the token is empty or unterminated. */
function readToken(raw: string): string | null {
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const end = raw.indexOf(quote, 1);
    return end > 1 ? raw.slice(1, end) : null;
  }
  let end = 0;
  while (end < raw.length && !PATH_TERMINATORS.has(raw[end])) end++;
  return end > 0 ? raw.slice(0, end) : null;
}
