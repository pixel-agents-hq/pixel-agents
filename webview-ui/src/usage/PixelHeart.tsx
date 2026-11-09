import { colorRuns } from '../components/ui/pixelGrid.js';
import { devicePixelsPerArtPixel } from '../components/ui/pixelSnap.js';
import { PixelSvg } from '../components/ui/PixelSvg.js';
import { PIXEL_ICON_SCALE, USAGE_HEART_COLORS } from '../constants.js';
import { useDevicePixelRatio } from '../hooks/useDevicePixelRatio.js';

/** The heart: outlined, red, shaded on the right, a highlight top-left.
 *  Letters are USAGE_HEART_COLORS keys; '.' is clear. */
const HEART = [
  '..oo.oo..',
  '.orrordo.',
  'orwrrrrdo',
  'orrrrrrdo',
  '.orrrrdo.',
  '..orrdo..',
  '...odo...',
  '....o....',
];

/** The beat: the same heart one pixel bigger all round, drawn over it. */
const HEART_BEAT = [
  '..ooo.ooo..',
  '.orrrorrdo.',
  'orwrrrrrrdo',
  'orrrrrrrrdo',
  'orrrrrrrrdo',
  '.orrrrrrdo.',
  '..orrrrdo..',
  '...orrdo...',
  '....odo....',
  '.....o.....',
];

/** One SVG of pixel art in several colours, each art pixel a whole number of
 *  device pixels (like PixelIcon). */
function PixelArt({
  grid,
  unit,
  className,
  style,
}: {
  grid: string[];
  unit: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <PixelSvg
      rects={colorRuns(grid).map(([x, y, w, ch]) => [x, y, w, USAGE_HEART_COLORS[ch]] as const)}
      width={grid[0].length}
      height={grid.length}
      unit={unit}
      className={className}
      style={style}
    />
  );
}

/** The usage bars' heart. With a period it beats lub-dub, once per period
 *  (the `.usage-heart-beat` keyframes): the bigger frame flashes over it, a
 *  swap of whole pixels, never a scale, and it takes no layout room. */
export function PixelHeart({ periodSec }: { periodSec: number | null }) {
  const dpr = useDevicePixelRatio();
  const unit = devicePixelsPerArtPixel(PIXEL_ICON_SCALE, dpr) / dpr;
  return (
    <span className="relative flex">
      <PixelArt grid={HEART} unit={unit} />
      {periodSec !== null && (
        <PixelArt
          grid={HEART_BEAT}
          unit={unit}
          className="absolute usage-heart-beat pointer-events-none"
          style={{ left: -unit, top: -unit, animationDuration: `${periodSec}s` }}
        />
      )}
    </span>
  );
}
