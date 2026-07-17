import { BUILDING_VIEW_FLOOR_GAP_PX, BUILDING_VIEW_TILE_PX } from '../constants.js';
import { getCatalogEntry } from '../office/layout/furnitureCatalog.js';
import type { OfficeFloor } from '../office/types.js';
import { TileType } from '../office/types.js';
import { Button } from './ui/Button.js';

interface BuildingViewProps {
  floors: OfficeFloor[];
  activeFloorId: string;
  onSelectFloor: (id: string) => void;
  onClose: () => void;
}

/** One swatch class per TileType. layout.tileColors stores Photoshop-style
 * adjust-mode deltas (applied to a base sprite texture), not literal HSL, so
 * it can't be reinterpreted as a CSS color directly — this schematic colors
 * by TileType instead, which is what actually distinguishes rooms/patterns. */
function tileClassName(t: number): string {
  return `building-view-tile-${t}`;
}

function FloorBlueprint({ floor }: { floor: OfficeFloor }) {
  const { cols, rows, tiles, furniture } = floor.layout;
  const w = cols * BUILDING_VIEW_TILE_PX;
  const h = rows * BUILDING_VIEW_TILE_PX;

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${cols} ${rows}`}
      shapeRendering="crispEdges"
      className="border-2 border-border shrink-0"
      data-testid={`building-view-blueprint-${floor.id}`}
    >
      {tiles.map((t, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const isWall = t === TileType.WALL || t === TileType.VOID;
        if (isWall) {
          return <rect key={i} x={col} y={row} width={1} height={1} fill="var(--color-bg-dark)" />;
        }
        return <rect key={i} x={col} y={row} width={1} height={1} className={tileClassName(t)} />;
      })}
      {furniture.map((item) => {
        const entry = getCatalogEntry(item.type);
        const fw = entry?.footprintW ?? 1;
        const fh = entry?.footprintH ?? 1;
        return (
          <rect
            key={item.uid}
            x={item.col}
            y={item.row}
            width={fw}
            height={fh}
            fill="var(--color-accent)"
          />
        );
      })}
    </svg>
  );
}

/**
 * Whole-building overview: every floor's blueprint stacked vertically,
 * newest on top / first floor at the bottom — same convention as
 * FloorSwitcher ("Building order: newest floor on top, first floor at the
 * bottom"). Static preview only (no live agents); click a floor to jump to
 * it in the main canvas.
 */
export function BuildingView({ floors, activeFloorId, onSelectFloor, onClose }: BuildingViewProps) {
  const displayFloors = [...floors].reverse();

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-49" onClick={onClose} />
      <div
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-bg border-2 border-border shadow-pixel p-10 max-w-[90vw] max-h-[90vh] overflow-auto"
        data-testid="building-view"
      >
        <div className="flex items-center justify-between mb-10 gap-20">
          <span className="text-accent-bright text-2xl">Building</span>
          <Button variant="ghost" size="icon" onClick={onClose} data-testid="building-view-close">
            x
          </Button>
        </div>
        <div className="flex flex-col items-center">
          {displayFloors.map((floor, index) => (
            <div
              key={floor.id}
              className="flex flex-col items-center cursor-pointer"
              style={{ marginTop: index === 0 ? 0 : BUILDING_VIEW_FLOOR_GAP_PX }}
              onClick={() => {
                onSelectFloor(floor.id);
                onClose();
              }}
              data-testid={`building-view-floor-${floor.id}`}
            >
              <span
                className={`text-sm mb-2 ${floor.id === activeFloorId ? 'text-accent-bright' : 'text-text-muted'}`}
              >
                {floor.name}
                {floor.id === activeFloorId ? ' (current)' : ''}
              </span>
              <FloorBlueprint floor={floor} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
