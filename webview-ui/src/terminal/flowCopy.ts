import { TERMINAL_COPY_WRAP_SLACK_COLS } from '../constants.js';

/** A line that may continue its predecessor: exactly two spaces, then a
 *  first word that does not read as intentional structure — list markers,
 *  todo boxes, tool-result elbows, box drawing, quotes, headers, numbered
 *  items. Deeper indents (code blocks) fail because the third character is
 *  still a space. Captures the first word for the fit check. */
const CONTINUATION = /^ {2}(?![-*•◦⎿☐☒│>#]|\d+[.)] )(\S+)/;

/**
 * Claude Code's TUI hard-wraps transcript prose at the terminal width with a
 * two-space continuation indent, so a multi-line copy comes out as ragged
 * visual rows instead of flowing text:
 *
 *     He'd stand in front of it for exactly as long
 *       as his wanderLimit allowed, then turn around
 *
 * Join those wraps back together — but only where the break carries that soft
 * wrap's signature: a continuation-shaped line (see CONTINUATION) whose first
 * word would NOT have fit on the row above. A wrap breaks a row precisely
 * because the next word overflowed it; a deliberate newline after a short row
 * (`foo:\n  bar: 1` in YAML, an indented JSON key, code) has room to spare and
 * keeps its break.
 *
 * `cols` is the terminal width the text was copied at. `firstLineCol` is the
 * column the copy started at: a selection that begins mid-row hands over a
 * first line shorter than the row it sits on.
 */
export function flowTerminalCopy(text: string, cols: number, firstLineCol = 0): string {
  const lines = text.split('\n').map((line) => line.trimEnd());
  let out = lines[0] ?? '';
  let rowWidth = firstLineCol + out.length;
  // Claude Code wraps a little short of the full width (its own gutters), so
  // "would not have fit" is judged against a slightly narrower row.
  const wrapWidth = cols - TERMINAL_COPY_WRAP_SLACK_COLS;
  for (const line of lines.slice(1)) {
    const firstWord = CONTINUATION.exec(line)?.[1];
    const isSoftWrap = firstWord !== undefined && rowWidth + 1 + firstWord.length > wrapWidth;
    out += isSoftWrap ? ` ${line.slice(2)}` : `\n${line}`;
    rowWidth = line.length;
  }
  return out;
}
