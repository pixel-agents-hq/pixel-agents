/**
 * Pixel grids: art written as rows of `#` (lit) and anything else (unlit),
 * the form of the 8×8 icons (pixelIcons.ts) and the number glyphs
 * (pixelFont.ts). DOM-free, so the canvas draws them the same way the SVGs do.
 */

/** A grid's lit pixels merged into horizontal runs (x, y, width; height 1),
 *  row by row, shifted right by `x0`: fewer rects, no seams. */
export function gridRuns(
  rows: readonly string[],
  x0 = 0,
): Array<[x: number, y: number, w: number]> {
  const out: Array<[number, number, number]> = [];
  rows.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x++) {
      const lit = row[x] === '#';
      if (lit && start < 0) start = x;
      if (!lit && start >= 0) {
        out.push([x0 + start, y, x - start]);
        start = -1;
      }
    }
  });
  return out;
}

/** A grid in several colours merged into horizontal runs (x, y, width, the
 *  run's character), row by row: each run is one character repeated, and
 *  `clear` marks no pixel. The multi-colour form of gridRuns. */
export function colorRuns(
  rows: readonly string[],
  clear = '.',
): Array<[x: number, y: number, w: number, ch: string]> {
  const out: Array<[number, number, number, string]> = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let end = x + 1;
      while (row[end] === ch) end++;
      if (ch !== clear) out.push([x, y, end - x, ch]);
      x = end;
    }
  });
  return out;
}

/** The box around a grid's lit pixels (inclusive), to centre what is drawn
 *  rather than the grid. An unlit grid gives an empty box (min > max). */
export function litBox(rows: readonly string[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  let minX = Infinity;
  let maxX = -1;
  let minY = Infinity;
  let maxY = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== '#') continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  });
  return { minX, maxX, minY, maxY };
}
