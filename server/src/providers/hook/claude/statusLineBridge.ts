/**
 * The status line bridge's command: how we write it, recognize it, and read
 * back the user's own status line from it. Pure — no file access — so the
 * installer and the backup predicate share one definition.
 *
 * Claude Code's `statusLine` setting holds ONE command (not a list like
 * `hooks.<Event>`), so the bridge cannot sit beside the user's status line; it
 * wraps it. The user's command rides inside ours, base64url-encoded:
 *
 *   node "/home/u/.pixel-agents/hooks/claude-statusline.js" --wrap <base64url>
 *
 * Encoded, not appended raw: Claude Code runs the whole string through a shell,
 * so a raw `cmd | other` after ours would be parsed by that shell — its pipe
 * would take OUR output. Base64url has no shell metacharacters. Carrying the
 * original in the command (rather than a side file) means there is no second
 * piece of state to lose: uninstall restores the user's command byte for byte
 * from the setting itself.
 */

import { isDeepStrictEqual } from 'util';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import { isRecord } from '../../../serverConfig.js';
import { commandRunsScript } from './commandIdentity.js';
import { CLAUDE_STATUSLINE_SCRIPT_NAME, STATUSLINE_WRAP_FLAG } from './constants.js';

/** The path suffix we own (lower case, anchored at a separator — see isOurHookCommand). */
const STATUSLINE_PATH_SUFFIX = `/${HOOK_SCRIPTS_DIR}/${CLAUDE_STATUSLINE_SCRIPT_NAME}`;

/** The `statusLine` setting's shape, as far as we read it. */
export interface StatusLineSetting {
  type?: unknown;
  command?: unknown;
  [key: string]: unknown;
}

/** Whether a command runs our status line script. */
export function isOurStatusLineCommand(command: string): boolean {
  return commandRunsScript(command, [STATUSLINE_PATH_SUFFIX]);
}

/** Whether a `statusLine` value is a command setting running our script. */
export function isOurStatusLine(value: unknown): value is StatusLineSetting & { command: string } {
  return (
    isRecord(value) && typeof value.command === 'string' && isOurStatusLineCommand(value.command)
  );
}

/** Our command, wrapping `wrapped` (the user's own status line) when given. */
export function makeStatusLineCommand(scriptPath: string, wrapped?: string): string {
  const base = `node "${scriptPath}"`;
  return wrapped === undefined
    ? base
    : `${base} ${STATUSLINE_WRAP_FLAG} ${Buffer.from(wrapped, 'utf-8').toString('base64url')}`;
}

/**
 * The user's command our command wraps: a string, `null` when ours wraps
 * nothing, or `undefined` when the text after our script is not something we
 * wrote (hand-edited) — the caller must then leave the setting alone, since it
 * cannot know what to restore.
 */
export function wrappedStatusLineCommand(command: string): string | null | undefined {
  if (!isOurStatusLineCommand(command)) return undefined;
  // Everything after our script path (and its closing quote, if quoted). The
  // search runs on a copy normalized 1:1 (separators, case), so its index is
  // valid in the original; the first token ends in our suffix, so its first
  // occurrence is the script path.
  const normalized = command.replace(/\\/g, '/').toLowerCase();
  const end = normalized.indexOf(STATUSLINE_PATH_SUFFIX) + STATUSLINE_PATH_SUFFIX.length;
  const rest = command.slice(end).replace(/^["']/, '').trim();
  if (rest === '') return null;
  const match = new RegExp(`^${STATUSLINE_WRAP_FLAG}\\s+([A-Za-z0-9_-]+)$`).exec(rest);
  if (!match) return undefined;
  const decoded = Buffer.from(match[1], 'base64url').toString('utf-8');
  // A round trip that doesn't reproduce the text means it was not ours to decode.
  return Buffer.from(decoded, 'utf-8').toString('base64url') === match[1] && decoded.trim() !== ''
    ? decoded
    : undefined;
}

/** What install writes into a settings file that had no status line: our
 *  command wrapping nothing, and no other field. The WRITER — isBareOurStatusLine
 *  compares against it. */
export function makeBareStatusLine(
  scriptPath: string,
): StatusLineSetting & { type: 'command'; command: string } {
  return { type: 'command', command: makeStatusLineCommand(scriptPath) };
}

/** Whether a `statusLine` value is exactly what install writes into a settings
 *  file that had no status line (makeBareStatusLine). The backup predicate
 *  reads that as our own output, like our hook entries.
 *
 *  Checked against the writer, not a hand-written twin of it (see
 *  hooksHoldOnlyOurs): every field but `command` must be one the writer writes,
 *  with the writer's value, and every field the writer writes must be there.
 *  `command` is exempt because the script path varies across homes; its
 *  identity is the suffix rule, and it must wrap nothing. */
export function isBareOurStatusLine(value: unknown): boolean {
  if (!isOurStatusLine(value) || wrappedStatusLineCommand(value.command) !== null) return false;
  const reference = new Map<string, unknown>(Object.entries(makeBareStatusLine('')));
  const fields = Object.entries(value);
  return (
    fields.every(
      ([key, field]) =>
        key === 'command' || (reference.has(key) && isDeepStrictEqual(field, reference.get(key))),
    ) && [...reference.keys()].every((key) => key in value)
  );
}
