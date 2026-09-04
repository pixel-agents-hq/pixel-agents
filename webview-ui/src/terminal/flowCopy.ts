/**
 * Claude Code's TUI hard-wraps transcript prose at the terminal width with a
 * two-space continuation indent, so a multi-line copy comes out as ragged
 * visual rows instead of flowing text:
 *
 *     He'd stand in front of it for exactly as long
 *       as his wanderLimit allowed, then turn around
 *
 * Join those wraps back together: a line starting with exactly two spaces
 * and a non-space continues its predecessor. Lines that read as intentional
 * structure keep their break — list markers, todo boxes, tool-result elbows,
 * box drawing, quotes, headers, numbered items — and deeper indents (code
 * blocks) are untouched because the third character is still a space.
 */
export function flowTerminalCopy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n {2}(?![-*•◦⎿☐☒│>#]|\d+[.)] )(?=\S)/g, ' ');
}
