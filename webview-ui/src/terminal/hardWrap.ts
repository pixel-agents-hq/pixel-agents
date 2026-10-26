/**
 * Claude Code's TUI breaks a token longer than its row (a URL, a path, a long
 * identifier) mid-word with a real newline, and carries on with it on the
 * next row after its block's indent:
 *
 *        ⎿  see https://github.com/pixel-agents-hq/pixel-a
 *           gents/pull/412
 *
 * xterm only knows its own wraps (`isWrapped`), so to it those are two lines:
 * a tap or click found half a link, and a copy came out with a newline and an
 * indent in the middle of it.
 *
 * The break has a signature an ordinary line doesn't: the row is filled to
 * its last column with no trailing space (a word wrap leaves room or a
 * space), the next row carries on after an indent, and the token the break
 * splits is longer than that row could have held (a word that fit would have
 * moved down whole).
 */

/**
 * How many leading columns of `next` are indent before it carries on the
 * token `row` was broken in, or null when `next` doesn't continue `row`.
 * `row` is a whole visual row from column 0, `cols` the terminal's width.
 */
export function hardWrapIndent(row: string, next: string, cols: number): number | null {
  // Measured in characters: a row holding wide characters reads short and
  // is left alone, which is the safe way to be wrong.
  if (row.length !== cols || /\s$/.test(row)) return null;
  const indent = next.length - next.trimStart().length;
  if (indent < 1 || indent === next.length) return null;
  const tail = /\S+$/.exec(row)?.[0].length ?? 0;
  const head = /^\S+/.exec(next.slice(indent))?.[0].length ?? 0;
  return tail + head > cols - indent ? indent : null;
}
