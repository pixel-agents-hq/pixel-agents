/**
 * Claude Code's "do you trust this folder?" question, the first thing a
 * session shows in a folder it has not been trusted in (kept by the CLI per
 * folder, in its own config). As of Claude Code 2.1.322 it is a two-row menu,
 *
 *   ❯ No, exit
 *     Yes, I trust this folder
 *
 * with the pointer on "No, exit". The answer is read off the screen rather
 * than assumed: the keys depend on where the pointer is, and a screen that
 * does not show both rows and a pointer on one of them is left alone.
 */

const YES_ROW = /Yes, I trust this folder/;
const NO_ROW = /No, exit/;
const POINTER = /^\s*❯/;

export function claudeTrustPromptKeys(screen: string): readonly ('up' | 'down' | 'enter')[] | null {
  const rows = screen.split('\n');
  const yes = rows.findIndex((row) => YES_ROW.test(row));
  const no = rows.findIndex((row) => NO_ROW.test(row));
  if (yes === -1 || no === -1) return null;
  if (POINTER.test(rows[yes])) return ['enter'];
  if (!POINTER.test(rows[no])) return null;
  return [yes > no ? 'down' : 'up', 'enter'];
}
