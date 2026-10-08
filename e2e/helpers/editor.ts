/**
 * Layout-editor driving helpers for the carpet, area and editor e2e specs.
 *
 * Tool selection goes through the REAL toolbar UI (same path a user takes).
 * Tile painting goes through `window.__pixelAgentsTestHooks.editorTileAction`
 * / `.editorEraseAction`, which call the same App-level handlers the canvas
 * calls — bypassing ONLY canvas pixel→tile geometry (mirrors the pets fixture's
 * petClick, see webview-ui/src/testHooks.ts). `dropFurnitureAt` bypasses more:
 * the whole drag gesture (press, movement, the Alt modifier, geometry) — only
 * the drop rules run. Gestures the canvas itself resolves (selecting a placed
 * item, dragging it, Alt-drag copying it) have real-mouse helpers too:
 * `clickTile` / `dragOnCanvas` press the mouse on the office canvas at a tile's
 * projected centre. Selectors are read from the live EditorToolbar.tsx; prefer
 * titles over text so they survive copy changes.
 */
import type { Frame, Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/** The carpet/area observability surface installed under the isE2E guard. */
export interface TestHooksWindow extends Window {
  __pixelAgentsTestHooks?: {
    getCarpetTiles?: () => Array<{
      col: number;
      row: number;
      variant: number;
      color?: unknown;
      accentColor?: unknown;
      order?: number;
    }>;
    getCarpetJunctionCase?: (jx: number, jy: number, variant: number) => number;
    getAreas?: () => Array<{ label: string; color: string }>;
    getAreaTiles?: () => Array<{ col: number; row: number; label: string }>;
    getAreaMappings?: () => Record<string, string[]>;
    getShowAreas?: () => boolean;
    getAgentSeats?: () => Array<{
      id: number;
      seatId: string | null;
      areaLabel: string | null;
      folderName?: string;
    }>;
    getSeats?: () => Array<{
      uid: string;
      col: number;
      row: number;
      areaLabel: string | null;
      assigned: boolean;
    }>;
    editorTileAction?: (col: number, row: number) => void;
    editorEraseAction?: (col: number, row: number) => void;
    editorDrop?: (uid: string, col: number, row: number, duplicate?: boolean) => void;
    getTileCenter?: (col: number, row: number) => { x: number; y: number } | null;
    getTiles?: () => { cols: number; rows: number; tiles: number[] };
    getFurniture?: () => Array<PlacedItem>;
    getFurnitureCount?: () => number;
    messageLog?: Array<{ type: string }>;
  };
}

/** A placed furniture item as the getFurniture hook reports it. */
export interface PlacedItem {
  uid: string;
  type: string;
  col: number;
  row: number;
  color?: { h: number; s: number; b: number; c: number; colorize?: boolean };
}

/** TileType values mirrored from webview-ui/src/office/types.ts. */
export const TILE = { WALL: 0, FLOOR_1: 1, FLOOR_2: 2, VOID: 255 } as const;

/**
 * Dismiss the first-run tooltips ("Instant Detection Active", "Updated to vN")
 * that overlay the top toolbar and would otherwise intercept the Layout click.
 * Mirrors the helper inlined in pets.spec.ts.
 */
export async function dismissFirstRunTooltips(frame: Frame): Promise<void> {
  for (const tooltipText of ['Instant Detection Active', 'Updated to v']) {
    const tooltip = frame.locator('div', { hasText: tooltipText }).first();
    if (await tooltip.isVisible().catch(() => false)) {
      const closeBtn = tooltip.locator('button', { hasText: 'x' }).first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click().catch(() => {});
      }
    }
  }
}

/** Enter the layout editor (idempotent-ish: only clicks the Layout button). */
export async function enterEditMode(frame: Frame): Promise<void> {
  await dismissFirstRunTooltips(frame);
  await frame.locator('button[title="Edit office layout"]').click();
}

/**
 * Open the Furniture panel, then select the Carpet category (→ CARPET_PAINT).
 * Carpet is a category INSIDE the Furniture panel, so the panel must be open
 * first (the "Paint carpets" tab only renders while Furniture is active).
 */
export async function selectCarpetTool(frame: Frame): Promise<void> {
  await frame.locator('button[title="Place furniture"]').click();
  await frame.locator('button[title="Paint carpets"]').click();
}

/** Select a carpet variant by index (thumbnails are titled "Carpet N", N=index+1). */
export async function selectCarpetVariant(frame: Frame, variant: number): Promise<void> {
  await frame.locator(`[title="Carpet ${variant + 1}"]`).click();
}

/** Switch to the carpet eyedropper (CARPET_PICK — the "Copy" button). */
export async function selectCarpetPickTool(frame: Frame): Promise<void> {
  await frame.locator('button[title*="Copy carpet"]').click();
}

/** Select the floor paint tool (TILE_PAINT). */
export async function selectFloorTool(frame: Frame): Promise<void> {
  await frame.locator('button[title="Paint floor tiles"]').click();
}

/** Select a floor pattern by TileType value (thumbnails are titled "Floor N"). */
export async function selectFloorPattern(frame: Frame, tileType: number): Promise<void> {
  await frame.locator(`[title="Floor ${tileType}"]`).click();
}

/** Select the wall paint tool (WALL_PAINT). */
export async function selectWallTool(frame: Frame): Promise<void> {
  await frame.locator('button[title="Paint walls (click to toggle)"]').click();
}

/** Select the erase tool (ERASE — clears tiles to VOID and deletes furniture). */
export async function selectEraseTool(frame: Frame): Promise<void> {
  await frame.locator('button[title="Erase tiles to void"]').click();
}

/**
 * End the current paint/erase stroke the way a user does — by releasing the
 * mouse over the canvas. Goes through OfficeCanvas's real onMouseUp handler
 * (which calls editorState.endStroke()), so the next tile starts a fresh undo
 * entry. Tile targeting bypasses canvas geometry, but stroke boundaries must
 * not: collapsing every edit into one undo entry is exactly the regression
 * these specs guard.
 */
export async function endStroke(frame: Frame): Promise<void> {
  await frame.locator('canvas').first().dispatchEvent('mouseup', { button: 0 });
}

/** Click Undo in the EditActionBar (only visible while the editor is dirty). */
export async function undo(frame: Frame): Promise<void> {
  await frame.locator('button', { hasText: 'Undo' }).click();
}

/** Select the Areas tool (button is gated on workspaceFolders > 0 → multi-root). */
export async function selectAreaTool(frame: Frame): Promise<void> {
  await frame.locator('button[title*="Define folder-bound areas"]').click();
}

/** Add a new Area via the Areas panel add-row. The placeholder uses a real ellipsis. */
export async function addArea(frame: Frame, name: string): Promise<void> {
  await frame.locator('input[placeholder="Area name…"]').fill(name);
  await frame.locator('button[title="Add a new Area"]').click();
}

/** Select an existing Area card (single click on its label bubbles to onSelect). */
export async function selectArea(frame: Frame, label: string): Promise<void> {
  await frame.locator(`span[title^="${label} —"]`).click();
}

/** Paint a tile with the active tool via the real tile-action handler (by col,row). */
export async function paintTile(frame: Frame, col: number, row: number): Promise<void> {
  await frame.evaluate(
    ([c, r]) => (window as TestHooksWindow).__pixelAgentsTestHooks?.editorTileAction?.(c, r),
    [col, row] as const,
  );
}

/** Erase a tile with the active tool via the real erase-action handler (by col,row). */
export async function eraseTile(frame: Frame, col: number, row: number): Promise<void> {
  await frame.evaluate(
    ([c, r]) => (window as TestHooksWindow).__pixelAgentsTestHooks?.editorEraseAction?.(c, r),
    [col, row] as const,
  );
}

/** Open the Furniture panel (FURNITURE_PLACE with no catalog item picked yet). */
export async function selectFurnitureTool(frame: Frame): Promise<void> {
  await frame.locator('button[title="Place furniture"]').click();
}

/**
 * The Furniture sub-panel's own Copy button — rendered only while that panel is
 * open, so its visibility stands in for "the panel is open" without reaching
 * into class names.
 */
export function furniturePanel(frame: Frame): Locator {
  return frame.locator('button[title="Copy furniture type from placed item"]');
}

/** The office canvas (the editor's click/drag surface). */
export function officeCanvas(frame: Frame): Locator {
  return frame.locator('[data-testid="office-canvas"]');
}

/**
 * Where tile (col,row)'s centre is on screen, in the page coordinates
 * `page.mouse` takes. The canvas projects tiles itself (zoom, pan, centring),
 * so the in-canvas offset comes from the renderer's own projection via the
 * getTileCenter hook; the canvas box places it on the page. Fails loudly if
 * anything (a toolbar, an overlay) covers the point — a real click there would
 * never reach the canvas.
 */
async function tilePagePoint(frame: Frame, col: number, row: number) {
  const box = await officeCanvas(frame).boundingBox();
  if (!box) throw new Error('office canvas is not rendered');
  const local = await frame.evaluate(
    ([c, r]) => {
      const center = (window as TestHooksWindow).__pixelAgentsTestHooks?.getTileCenter?.(c, r);
      const canvas = document.querySelector('[data-testid="office-canvas"]');
      if (!center || !canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + center.x, rect.top + center.y);
      return { ...center, onCanvas: top === canvas };
    },
    [col, row] as const,
  );
  if (!local) throw new Error(`tile (${col},${row}) has no projection yet`);
  if (!local.onCanvas) throw new Error(`tile (${col},${row}) is covered — not clickable on canvas`);
  return { x: box.x + local.x, y: box.y + local.y };
}

/**
 * A real left click on the canvas at tile (col,row): mousedown + mouseup,
 * through OfficeCanvas's own hit-testing. On a placed item that selects it (or
 * deselects it if already selected), exactly as a user's click does.
 */
export async function clickTile(frame: Frame, col: number, row: number): Promise<void> {
  const p = await tilePagePoint(frame, col, row);
  await frame.page().mouse.click(p.x, p.y);
}

/** Select a placed item by clicking one of its tiles on the canvas. */
export async function selectFurnitureAt(frame: Frame, col: number, row: number): Promise<void> {
  await clickTile(frame, col, row);
}

/**
 * A real mouse drag on the canvas from tile `from` to tile `to` — press,
 * move across the tiles, release — with Alt held throughout when `alt` is set
 * (the copy gesture). The item under `from` moves (or is copied) by the same
 * tile delta, so grab it by any of its tiles.
 */
export async function dragOnCanvas(
  frame: Frame,
  from: readonly [number, number],
  to: readonly [number, number],
  opts: { alt?: boolean } = {},
): Promise<void> {
  const mouse = frame.page().mouse;
  const keyboard = frame.page().keyboard;
  const start = await tilePagePoint(frame, from[0], from[1]);
  const end = await tilePagePoint(frame, to[0], to[1]);
  await mouse.move(start.x, start.y);
  if (opts.alt) await keyboard.down('Alt');
  try {
    await mouse.down();
    await mouse.move(end.x, end.y, { steps: 8 });
    await mouse.up();
  } finally {
    if (opts.alt) await keyboard.up('Alt');
  }
}

/**
 * Release a drag of `uid` at (col,row) through the real drop handler, with
 * `duplicate` standing in for Alt. Skips the whole mouse gesture — press,
 * movement, the Alt modifier, pixel→tile geometry — so it pins the drop rules
 * (what rides along, whether the group fits, what ends up selected), not the
 * gesture; dragOnCanvas covers that.
 */
export async function dropFurnitureAt(
  frame: Frame,
  uid: string,
  col: number,
  row: number,
  opts: { duplicate?: boolean } = {},
): Promise<void> {
  await frame.evaluate(
    ([u, c, r, d]) =>
      (window as TestHooksWindow).__pixelAgentsTestHooks?.editorDrop?.(
        u as string,
        c as number,
        r as number,
        d as boolean,
      ),
    [uid, col, row, !!opts.duplicate] as const,
  );
}

/**
 * Press an editor shortcut (R rotates, T toggles state) as a real keydown on
 * the webview window — useEditorKeyboard listens there.
 */
export async function pressEditorKey(frame: Frame, key: string): Promise<void> {
  await frame.locator('body').press(key);
}

/** Save the layout via the EditActionBar (only visible while the editor is dirty). */
export async function saveLayout(frame: Frame): Promise<void> {
  const saveBtn = frame.locator('button', { hasText: 'Save' });
  await expect(saveBtn).toBeVisible({ timeout: 5_000 });
  await saveBtn.click();
}

/** Read the TileType values at the given (col,row) pairs, in order. */
export async function readTilesAt(frame: Frame, cells: Array<[number, number]>): Promise<number[]> {
  return frame.evaluate((pairs) => {
    const grid = (window as TestHooksWindow).__pixelAgentsTestHooks?.getTiles?.();
    if (!grid) return [];
    return pairs.map(([c, r]) => grid.tiles[r * grid.cols + c]);
  }, cells);
}

/** Read placed furniture (uid + type + grid coords + colour) from the test hook. */
export async function readFurniture(frame: Frame): Promise<PlacedItem[]> {
  return frame.evaluate(
    () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getFurniture?.() ?? [],
  );
}

/**
 * Assert a negative outcome HOLDS: `read()` must keep equalling `expected` on
 * every poll across `windowMs`, not just on the first read — a refused edit
 * that lands late (a debounce, a re-render) would slip past a one-shot check.
 */
export async function expectStays<T>(
  read: () => Promise<T>,
  expected: T,
  windowMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  do {
    const value: unknown = await read();
    expect(value).toEqual(expected);
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
}

/** Read the painted carpet tiles from the test hook. */
export async function readCarpetTiles(
  frame: Frame,
): Promise<Array<{ col: number; row: number; variant: number }>> {
  return frame.evaluate(
    () =>
      (window as TestHooksWindow).__pixelAgentsTestHooks?.getCarpetTiles?.().map((t) => ({
        col: t.col,
        row: t.row,
        variant: t.variant,
      })) ?? [],
  );
}

/** Read the 4-bit junction case (NW=1,NE=2,SE=4,SW=8) via the renderer logic. */
export async function readCarpetJunctionCase(
  frame: Frame,
  jx: number,
  jy: number,
  variant: number,
): Promise<number> {
  return frame.evaluate(
    ([x, y, v]) =>
      (window as TestHooksWindow).__pixelAgentsTestHooks?.getCarpetJunctionCase?.(x, y, v) ?? 0,
    [jx, jy, variant] as const,
  );
}

/** Read the area-painted tiles from the test hook. */
export async function readAreaTiles(
  frame: Frame,
): Promise<Array<{ col: number; row: number; label: string }>> {
  return frame.evaluate(
    () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getAreaTiles?.() ?? [],
  );
}

/** Read the Area definitions from the test hook. */
export async function readAreas(frame: Frame): Promise<Array<{ label: string; color: string }>> {
  return frame.evaluate(
    () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getAreas?.() ?? [],
  );
}

/** Read all seats (uid + coords + the area their tile falls in). */
export async function readSeats(
  frame: Frame,
): Promise<
  Array<{ uid: string; col: number; row: number; areaLabel: string | null; assigned: boolean }>
> {
  return frame.evaluate(
    () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getSeats?.() ?? [],
  );
}

/** Read seated agents with the area their seat falls in. */
export async function readAgentSeats(
  frame: Frame,
): Promise<
  Array<{ id: number; seatId: string | null; areaLabel: string | null; folderName?: string }>
> {
  return frame.evaluate(
    () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getAgentSeats?.() ?? [],
  );
}
