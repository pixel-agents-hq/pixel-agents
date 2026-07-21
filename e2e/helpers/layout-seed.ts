/**
 * Builders for seeded `~/.pixel-agents/{layout,config}.json`, passed to the
 * pixelAgents fixture via `test.use({ seedLayout, seedConfig })`. The fixture
 * writes them under the isolated HOME BEFORE VS Code launches (see
 * e2e/helpers/launch.ts), so the server reads them on startup.
 *
 * A seeded layout MUST carry a layoutRevision above the bundled default's (1),
 * or `loadLayout` resets it to the bundled default
 * (server/src/layoutPersistence.ts). SEED_LAYOUT_REVISION sits far above that.
 */

/** Far above the bundled default-layout revision so a seeded layout survives load. */
export const SEED_LAYOUT_REVISION = 9999;

/** Default floor TileType used to fill a seeded grid (FLOOR_1 = 1). */
const FLOOR_1 = 1;

export interface SeedAreaTile {
  col: number;
  row: number;
  label: string;
}

export interface SeedCarpetTile {
  col: number;
  row: number;
  variant: number;
}

export interface SeedLayoutOptions {
  cols?: number;
  rows?: number;
  /** TileType value to fill every tile with (default FLOOR_1). */
  floorTile?: number;
  areas?: Array<{ label: string; color: string }>;
  /** Sparse area-tile labels; expanded to a full parallel array. */
  areaTiles?: SeedAreaTile[];
  /** Sparse carpet tiles; expanded to a full parallel array (default colors). */
  carpetTiles?: SeedCarpetTile[];
}

/**
 * Build a minimal valid OfficeLayout (version 1, all-floor, no furniture) with
 * optional carpet/area data, suitable for `test.use({ seedLayout })`. No chairs
 * means no seats — use the bundled default layout (don't seed) for seat tests.
 */
export function buildSeedLayout(opts: SeedLayoutOptions = {}): Record<string, unknown> {
  const cols = opts.cols ?? 12;
  const rows = opts.rows ?? 12;
  const count = cols * rows;
  const tiles = new Array<number>(count).fill(opts.floorTile ?? FLOOR_1);

  const layout: Record<string, unknown> = {
    version: 1,
    cols,
    rows,
    tiles,
    furniture: [],
    layoutRevision: SEED_LAYOUT_REVISION,
  };

  if (opts.areas) {
    layout.areas = opts.areas;
  }
  if (opts.areaTiles) {
    const areaTiles = new Array<string | null>(count).fill(null);
    for (const t of opts.areaTiles) {
      areaTiles[t.row * cols + t.col] = t.label;
    }
    layout.areaTiles = areaTiles;
  }
  if (opts.carpetTiles) {
    const carpetTiles = new Array<{ variant: number } | null>(count).fill(null);
    for (const t of opts.carpetTiles) {
      carpetTiles[t.row * cols + t.col] = { variant: t.variant };
    }
    layout.carpetTiles = carpetTiles;
  }

  return layout;
}

/**
 * Mirrors server/src/configPersistence.ts DEFAULT_ADAPTER_SETTINGS, except
 * alwaysShowLabels — the e2e baseline turns labels on so overlay text is
 * assertable without hover (same default the launch-level seed applies when a
 * test passes no seedConfig; see e2e/helpers/launch.ts).
 */
const DEFAULT_ADAPTER_SETTINGS = {
  soundEnabled: true,
  lastSeenVersion: '',
  alwaysShowLabels: true,
  watchAllSessions: false,
  hooksEnabled: true,
  hooksInfoShown: false,
  showAreas: false,
  areaMappings: {} as Record<string, string[]>,
};

export interface SeedConfigOptions {
  /** Folder name → Area labels (written into the vscode namespace). */
  areaMappings?: Record<string, string[]>;
  /** Persisted Show Areas state for the vscode namespace. */
  showAreas?: boolean;
}

/**
 * Build a full PixelAgentsConfig for `test.use({ seedConfig })`, setting the
 * vscode namespace's areaMappings / showAreas. The standalone namespace keeps
 * defaults so there is no cross-namespace leak.
 */
export function buildSeedConfig(opts: SeedConfigOptions = {}): Record<string, unknown> {
  return {
    vscode: {
      ...DEFAULT_ADAPTER_SETTINGS,
      showAreas: opts.showAreas ?? false,
      areaMappings: opts.areaMappings ?? {},
    },
    standalone: { ...DEFAULT_ADAPTER_SETTINGS },
    externalAssetDirectories: [],
  };
}
