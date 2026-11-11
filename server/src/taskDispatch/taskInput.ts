/**
 * The text of a dispatched task: what is accepted, and the exact bytes written
 * into the target's PTY.
 *
 * Validation REJECTS, it never strips: a task with anything a terminal could
 * act on is refused as a whole, so what the target receives is always exactly
 * what the curator sent (after CRLF -> LF).
 *
 * Framing: a fixed first line names the sender, so the curator's text is never
 * the first character of the input (no slash command, `!` shell or `#` memory
 * prefix can take effect); the whole input is wrapped in bracketed-paste
 * markers synthesized here, and the submitting CR comes after the end marker.
 */

import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  C0_CONTROL_MAX,
  C1_CONTROL_MAX,
  C1_CONTROL_MIN,
  DEL_CONTROL,
  LINE_FEED,
  TASK_DISPATCH_MAX_TASK_CHARS,
  TASK_DISPATCH_PREFIX_LABEL,
} from '../constants.js';

export type TaskTextResult = { ok: true; text: string } | { ok: false };

/** C0 (except LF), DEL, or C1 anywhere. CR is C0, so a lone CR (left after
 *  CRLF -> LF) and ESC (any escape sequence, including a paste end marker) are
 *  refused. Code units, so a surrogate pair is never mistaken for a control. */
function hasForbiddenControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === LINE_FEED) continue;
    if (code <= C0_CONTROL_MAX || code === DEL_CONTROL) return true;
    if (code >= C1_CONTROL_MIN && code <= C1_CONTROL_MAX) return true;
  }
  return false;
}

/**
 * An `@` that starts a token (start of text, after whitespace or an opening
 * bracket/quote) followed by anything that is not whitespace: Claude Code's
 * file-mention syntax. Broader than "looks like a path" on purpose -- refusing
 * `@team` costs a rephrase, accepting `@~/.ssh/id_rsa` costs a file read.
 */
const AT_MENTION = /(?:^|[\s([{<"'`])@\S/u;

/** Validate a task: CRLF -> LF, then every rule; the normalized text or a refusal. */
export function validateTaskText(raw: unknown): TaskTextResult {
  if (typeof raw !== 'string') return { ok: false };
  const text = raw.replace(/\r\n/g, '\n');
  if (text.trim().length === 0) return { ok: false };
  if (text.length > TASK_DISPATCH_MAX_TASK_CHARS) return { ok: false };
  if (hasForbiddenControl(text)) return { ok: false };
  if (AT_MENTION.test(text)) return { ok: false };
  return { ok: true, text };
}

/** The fixed first line: who sent the task. The caller id comes from the capability. */
export function taskPrefixLine(callerAgentId: number): string {
  return `[${TASK_DISPATCH_PREFIX_LABEL} (agent ${callerAgentId})]`;
}

/**
 * The exact PTY input for a validated task: paste start, prefix line, LF, the
 * task, paste end, then CR (outside the markers) to submit.
 */
export function frameTaskInput(callerAgentId: number, validatedText: string): string {
  return `${BRACKETED_PASTE_START}${taskPrefixLine(callerAgentId)}\n${validatedText}${BRACKETED_PASTE_END}\r`;
}
