import { TERMINAL_COPY_WRAP_SLACK_COLS } from '../constants.js';
import { hardWrapIndent } from './hardWrap.js';

/** A line that may continue its predecessor: exactly two spaces, then a
 *  first word that does not read as intentional structure — list markers,
 *  todo boxes, tool-result elbows, box drawing, quotes, headers, numbered
 *  items. Deeper indents (code blocks) fail because the third character is
 *  still a space. Captures the first word for the fit check. */
const CONTINUATION = /^ {2}(?![-*•◦⎿☐☒│>#]|\d+[.)] )(\S+)/;

/** How a terminal selection is copied: exactly as on screen (the default,
 *  every plain copy), or re-flowed as prose (the opt-in "Copy as text"). */
export type TerminalCopyMode = 'verbatim' | 'text';

/**
 * The clipboard text for a terminal selection. Every copy joins the tokens
 * Claude Code broke mid-word across rows (a URL, a path; hardWrap.ts) back
 * together: that break has a signature an intended newline doesn't. Re-flowing
 * word-wrapped prose is a heuristic, and on text that only looks like a soft
 * wrap (a long row, then a two-space-indented line — YAML under a long key, a
 * method body under a long signature) it joins lines the user meant, so it is
 * only applied when asked for ("Copy as text").
 *
 * `cols` is the terminal width the text was copied at. `firstLineCol` is the
 * column the copy started at: a selection that begins mid-row hands over a
 * first line shorter than the row it sits on.
 */
export function terminalCopyText(
  selection: string,
  mode: TerminalCopyMode,
  cols: number,
  firstLineCol = 0,
): string {
  return joinRows(selection, cols, firstLineCol, mode === 'text');
}

/**
 * Join the selection's rows where one carries on the last: a broken token
 * always (no space), a word-wrapped line when `prose` (one space).
 *
 * Claude Code's TUI hard-wraps transcript prose at the terminal width with a
 * two-space continuation indent, so a multi-line copy comes out as ragged
 * visual rows instead of flowing text:
 *
 *     He'd stand in front of it for exactly as long
 *       as his wanderLimit allowed, then turn around
 *
 * `prose` joins those wraps back together — but only where the break carries that soft
 * wrap's signature: a continuation-shaped line (see CONTINUATION) whose first
 * word would NOT have fit on the row above. A wrap breaks a row precisely
 * because the next word overflowed it; a deliberate newline after a short row
 * (`foo:\n  bar: 1` in YAML, an indented JSON key, code) has room to spare and
 * keeps its break.
 */
function joinRows(text: string, cols: number, firstLineCol: number, prose: boolean): string {
  const sep = text.includes('\r\n') ? '\r\n' : '\n';
  const rows = text.split(sep).map((row) => (prose ? row.trimEnd() : row));
  let out = rows[0] ?? '';
  // The row above as it stood on screen, from column 0.
  let above = ' '.repeat(Math.max(0, firstLineCol)) + out;
  // Claude Code wraps a little short of the full width (its own gutters), so
  // "would not have fit" is judged against a slightly narrower row.
  const wrapWidth = cols - TERMINAL_COPY_WRAP_SLACK_COLS;
  for (const row of rows.slice(1)) {
    const indent = hardWrapIndent(above, row, cols);
    const firstWord = prose ? CONTINUATION.exec(row)?.[1] : undefined;
    if (indent !== null) {
      out += row.slice(indent);
    } else if (firstWord !== undefined && above.length + 1 + firstWord.length > wrapWidth) {
      out += ` ${row.slice(2)}`;
    } else {
      out += sep + row;
    }
    above = row;
  }
  return out;
}
