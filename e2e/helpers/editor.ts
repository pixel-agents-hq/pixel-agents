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
import type { Frame } from '@playwright/test';
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
    messageLog?: Array<{ type: string }>;
  };
}

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

/** Switch to the carpet eyedropper (CARPET_PICK). */
export async function selectCarpetPickTool(frame: Frame): Promise<void> {
  await frame.locator('button[title*="Pick carpet"]').click();
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

/** Save the layout via the EditActionBar (only visible while the editor is dirty). */
export async function saveLayout(frame: Frame): Promise<void> {
  const saveBtn = frame.locator('button', { hasText: 'Save' });
  await expect(saveBtn).toBeVisible({ timeout: 5_000 });
  await saveBtn.click();
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
