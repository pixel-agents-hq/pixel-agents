/**
 * The TUI's input area: the rows a long press offers Paste on. Claude Code
 * draws its prompt box as horizontal rules above and below the input (older
 * versions as a rounded box), with the cursor inside, so the area is the
 * cursor's row out to the nearest rule above and below it, rules included.
 * Without rules in reach (another TUI, a menu on screen) it is the cursor's
 * row alone. Pure: the caller reads the buffer.
 */

import {
  TERMINAL_INPUT_AREA_MAX_SCAN_ROWS,
  TERMINAL_RULE_MIN_CHARS,
  TERMINAL_RULE_MIN_SHARE,
} from '../constants.js';

const BOX_LINE = /[─━═╌╍┄┅┈┉╭╮╰╯┌┐└┘]/g;

/** A row drawn as a horizontal rule (a box edge). */
export function isRuleRow(text: string): boolean {
  const ink = text.replace(/\s/g, '');
  const lines = ink.match(BOX_LINE)?.length ?? 0;
  return lines >= TERMINAL_RULE_MIN_CHARS && lines >= ink.length * TERMINAL_RULE_MIN_SHARE;
}

/** The input area's first and last row (absolute buffer rows, inclusive). */
export function inputAreaRows(
  lineAt: (row: number) => string | undefined,
  cursorRow: number,
): { startRow: number; endRow: number } {
  const find = (dir: -1 | 1): number | null => {
    for (let i = 1; i <= TERMINAL_INPUT_AREA_MAX_SCAN_ROWS; i++) {
      const text = lineAt(cursorRow + dir * i);
      if (text === undefined) return null;
      if (isRuleRow(text)) return cursorRow + dir * i;
    }
    return null;
  };
  const above = find(-1);
  const below = find(1);
  if (above === null || below === null) return { startRow: cursorRow, endRow: cursorRow };
  return { startRow: above, endRow: below };
}
