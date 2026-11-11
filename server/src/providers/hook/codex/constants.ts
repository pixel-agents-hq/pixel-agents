/**
 * Codex-specific constants. Kept in one file so the hook surface (which events
 * we install) and the display strings are auditable in a single place.
 */

/** Hook events to install in Codex's hooks config. This list is the whole
 *  data-collection surface: Codex runs each of these and pipes the payload to
 *  our local server, so an event we do not act on is scope we should not ask for.
 *
 *  SessionStart/SessionEnd handle session lifecycle.
 *  PreToolUse/PostToolUse drive the typing/reading animations.
 *  PermissionRequest raises the "needs you" speech bubble.
 *  Stop ends the turn (character stands up / goes idle).
 *  SubagentStart/SubagentStop spawn and retire sub-agent characters.
 *
 *  Deliberately NOT installed, mirroring the Claude provider's restraint:
 *  - UserPromptSubmit: would forward the user's prompt text for nothing the
 *    runtime consumes.
 *  - PreCompact/PostCompact: compaction is invisible in the office.
 *  - Interrupt: Stop already returns the character to idle. */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SubagentStart',
  'SubagentStop',
] as const;

/** Provider id on the wire. Must stay stable: it keys the consent record and
 *  the hooks-enabled setting. */
export const CODEX_PROVIDER_ID = 'codex';

export const CODEX_DISPLAY_NAME = 'Codex';

/** Terminal name prefix used when launching the CLI, so the VS Code adapter can
 *  match terminals to agents. */
export const CODEX_TERMINAL_NAME_PREFIX = 'Codex';

/** Directory holding Codex's user-level config, relative to the home dir. */
export const CODEX_CONFIG_DIR = '.codex';

/** Standalone hooks file we write. Codex also supports inline `[hooks]` tables
 *  in config.toml, but a separate JSON file is the safer target: we never have
 *  to parse or rewrite the user's TOML, so a malformed merge cannot break their
 *  model/provider settings. */
export const CODEX_HOOKS_FILE = 'hooks.json';

/** One-time backup of a pre-existing hooks.json, written before our first
 *  modification. Brand-named rather than a generic `.backup`, which would
 *  collide with another tool's convention: a foreign `.backup` next to
 *  hooks.json must not make us believe we already saved the user's original. */
export const HOOKS_BACKUP_SUFFIX = '.pixel-agents.backup';

/** Suffix of the temp file used for the atomic tmp-write + rename. */
export const HOOKS_TMP_SUFFIX = '.pixel-agents-tmp';

/** Where the hook script is installed (under the shared ~/.pixel-agents tree,
 *  alongside the Claude one). */
export const CODEX_HOOK_SCRIPT_NAME = 'codex-hook.js';

/** Path fragment identifying a command as ours, used when deciding whether an
 *  entry in the user's hooks.json belongs to us and may be removed. */
export const HOOK_PATH_SUFFIX = `/${CODEX_HOOK_SCRIPT_NAME}`;

/** Codex context windows, by model family. Only the provider can map a model id
 *  a transcript reports to the window it counts against, and getting it wrong is
 *  visible: the office renders usage/window as a context gauge over every
 *  character. Conservative by design — the runtime widens its estimate if a real
 *  context ever exceeds what we return. */
export const CODEX_DEFAULT_CONTEXT_WINDOW = 272_000;

/** Models whose window differs from the default. Matched case-insensitively as
 *  substrings, longest first, because Codex reports ids with date and variant
 *  suffixes (`gpt-5.1-codex-max-20260115`) that we must not enumerate. */
export const CODEX_CONTEXT_WINDOW_PATTERNS: ReadonlyArray<readonly [string, number]> = [
  ['gpt-4.1', 1_047_576],
  ['gpt-4o', 128_000],
  ['o3', 200_000],
  ['o4', 200_000],
];

/** Max chars of a shell command rendered in the status line. */
export const SHELL_COMMAND_DISPLAY_MAX_LENGTH = 40;

/** Timeout we request for a normal hook. Generous relative to the script's own
 *  2s per-request budget; it exists only so a wedged `node` cannot sit around. */
export const HOOK_TIMEOUT_SECONDS = 5;

/** Codex caps SessionEnd and Interrupt at 3s (default 1s) and runs them
 *  synchronously even when `async: true`. Asking for more makes Codex print a
 *  clamping warning about our own config at every startup. */
export const SESSION_END_MAX_TIMEOUT_SECONDS = 3;
