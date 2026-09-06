/**
 * Layout-editor driving helpers for carpet + area e2e specs.
 *
 * Tool selection goes through the REAL toolbar UI (same path a user takes).
 * Tile targeting goes through `window.__pixelAgentsTestHooks.editorTileAction`
 * / `.editorEraseAction`, which call the same App-level handlers the canvas
 * calls — bypassing ONLY canvas pixel→tile geometry (mirrors the pets fixture's
 * petClick, see webview-ui/src/testHooks.ts). Selectors are read from the live
 * EditorToolbar.tsx; prefer titles over text so they survive copy changes.
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
      directoryName?: string;
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
    editorDragMove?: (uid: string, col: number, row: number) => void;
    editorDragDuplicate?: (uid: string, col: number, row: number) => void;
    getTiles?: () => { cols: number; rows: number; tiles: number[] };
    getFurniture?: () => Array<{ uid: string; type: string; col: number; row: number }>;
    getFurnitureCount?: () => number;
    messageLog?: Array<{ type: string }>;
  };
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

/** Leave the layout editor — the same Layout button toggles it. Save first:
 *  this makes no attempt to handle unsaved edits. */
export async function exitEditMode(frame: Frame): Promise<void> {
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

/** Select the Areas tool (button is gated on mappable directories > 0 → multi-root). */
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

/**
 * Select a placed item by clicking its tile. Real selection path: both SELECT
 * and the Furniture panel (with no catalog item picked) resolve the click to
 * the furniture under the tile in handleEditorTileAction.
 */
export async function selectFurnitureAt(frame: Frame, col: number, row: number): Promise<void> {
  await paintTile(frame, col, row);
}

/**
 * Press an editor shortcut (R rotates, T toggles state) as a real keydown on
 * the webview window — useEditorKeyboard listens there.
 */
export async function pressEditorKey(frame: Frame, key: string): Promise<void> {
  await frame.locator('body').press(key);
}

/**
 * Drop a dragged item at (col,row) through the real drag-move handler. Bypasses
 * the mouse gesture only — moveFurniture still decides what comes along (items
 * on a desk's surface) and whether the group fits.
 */
export async function dragFurnitureTo(
  frame: Frame,
  uid: string,
  col: number,
  row: number,
): Promise<void> {
  await frame.evaluate(
    ([u, c, r]) =>
      (window as TestHooksWindow).__pixelAgentsTestHooks?.editorDragMove?.(
        u as string,
        c as number,
        r as number,
      ),
    [uid, col, row] as const,
  );
}

/**
 * Drop an Alt-drag copy at (col,row) through the real duplicate handler. Same
 * bypass as dragFurnitureTo — the altKey gesture is the only thing skipped;
 * duplicateFurniture still decides what is copied and whether the copy fits.
 */
export async function duplicateFurnitureTo(
  frame: Frame,
  uid: string,
  col: number,
  row: number,
): Promise<void> {
  await frame.evaluate(
    ([u, c, r]) =>
      (window as TestHooksWindow).__pixelAgentsTestHooks?.editorDragDuplicate?.(
        u as string,
        c as number,
        r as number,
      ),
    [uid, col, row] as const,
  );
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

/** Read placed furniture (uid + type + grid coords) from the test hook. */
export async function readFurniture(
  frame: Frame,
): Promise<Array<{ uid: string; type: string; col: number; row: number }>> {
  return frame.evaluate(
    () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getFurniture?.() ?? [],
  );
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
  Array<{ id: number; seatId: string | null; areaLabel: string | null; directoryName?: string }>
> {
  return frame.evaluate(
    () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getAgentSeats?.() ?? [],
  );
}
