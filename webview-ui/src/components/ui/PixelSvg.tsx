import type { CSSProperties } from 'react';

/**
 * Pixel art as an SVG in the text colour: one rect per run (pixelGrid.ts
 * `gridRuns`; a run carrying a fill, from `colorRuns`, is drawn in it),
 * `unit` CSS px per art pixel. Callers snap `unit` to whole
 * device pixels (pixelSnap.ts), so every row and column comes out equal.
 */
export function PixelSvg({
  rects,
  width,
  height,
  unit,
  className = '',
  style,
}: {
  rects: ReadonlyArray<readonly [x: number, y: number, w: number, fill?: string]>;
  /** Art pixels across and down. */
  width: number;
  height: number;
  unit: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={width * unit}
      height={height * unit}
      viewBox={`0 0 ${width} ${height}`}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
      style={style}
    >
      {rects.map(([x, y, w, fill]) => (
        <rect key={`${x}:${y}`} x={x} y={y} width={w} height={1} fill={fill} />
      ))}
    </svg>
  );
}
