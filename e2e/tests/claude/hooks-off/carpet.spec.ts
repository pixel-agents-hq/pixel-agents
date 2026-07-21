import type { Frame } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import { expect, test } from '../../../fixtures/pixel-agents';
import {
  enterEditMode,
  paintTile,
  readCarpetJunctionCase,
  readCarpetTiles,
  saveLayout,
  selectCarpetPickTool,
  selectCarpetTool,
  selectCarpetVariant,
  type TestHooksWindow,
} from '../../../helpers/editor';
import { buildSeedLayout } from '../../../helpers/layout-seed';
import { closeBottomPanel, getPixelAgentsFrame, reopenBottomPanel } from '../../../helpers/webview';

/**
 * e2e coverage for the carpet system (a tile layer between floor and furniture).
 *
 * Carpet tiles render only on the canvas (no DOM) and the marching-squares
 * autotile case is render-derived (not stored), so assertions read state through
 * window.__pixelAgentsTestHooks.getCarpetTiles() / getCarpetJunctionCase() — the
 * same canvas-state approach the pets fixture uses. Tool selection goes through
 * the real toolbar; tile targeting goes through the editorTileAction hook, which
 * bypasses ONLY canvas pixel→tile geometry (see webview-ui/src/testHooks.ts).
 *
 * hooks-off lane: carpet has no hook dependency; this is the lighter fixture.
 */

const CARPET_THUMB = (variant: number) => `[title="Carpet ${variant + 1}"]`;

async function waitForCarpetCount(frame: Frame, count: number): Promise<void> {
  await frame.waitForFunction(
    (n) =>
      ((window as TestHooksWindow).__pixelAgentsTestHooks?.getCarpetTiles?.() ?? []).length === n,
    count,
    { timeout: 10_000 },
  );
}

test.describe('Carpet', () => {
  // Seed a small all-floor layout so paintTile(col,row) lands on a paintable
  // tile — carpet (and area) painting is gated to non-VOID/non-WALL tiles
  // (useEditorActions.ts), and the bundled default layout's tiles vary.
  test.use({ seedLayout: buildSeedLayout({ cols: 12, rows: 12 }) });

  test('carpet sprites load + broadcast, and the Carpet category renders variants @area:carpet', async ({
    pixelAgents,
  }) => {
    const { frame, narrator } = pixelAgents;

    // carpetTilesLoaded is sent once after webviewReady — proven via the message log.
    narrator.step('waiting for the carpet sprites to load and broadcast to the webview');
    await frame.waitForFunction(() => {
      const log = (window as TestHooksWindow).__pixelAgentsTestHooks?.messageLog ?? [];
      return log.some((m) => m.type === 'carpetTilesLoaded');
    });
    narrator.check('carpetTilesLoaded message received — sprites are ready');

    narrator.step('opening the layout editor and selecting the carpet tool');
    await enterEditMode(frame);
    await selectCarpetTool(frame);
    // At least one carpet variant thumbnail renders inside the Furniture panel.
    await expect(frame.locator(CARPET_THUMB(0))).toBeVisible({ timeout: 15_000 });
    narrator.check('"Carpet 1" variant thumbnail renders in the Furniture panel');
  });

  test('painting a tile records it in the carpet layer @area:carpet', async ({ pixelAgents }) => {
    const { frame, narrator } = pixelAgents;
    narrator.step('opening the layout editor and selecting the carpet tool');
    await enterEditMode(frame);
    await selectCarpetTool(frame);
    await selectCarpetVariant(frame, 0);

    narrator.step('painting a carpet tile at (4,4)');
    await paintTile(frame, 4, 4);
    await waitForCarpetCount(frame, 1);
    narrator.check('one tile recorded in the carpet layer');

    const tiles = await readCarpetTiles(frame);
    expect(tiles).toContainEqual({ col: 4, row: 4, variant: 0 });
    narrator.check('exactly {col:4, row:4, variant:0} was recorded');
  });

  test('autotiling: the junction case reflects neighboring carpet tiles @area:carpet', async ({
    pixelAgents,
  }) => {
    const { frame, narrator } = pixelAgents;
    narrator.step('opening the layout editor and selecting the carpet tool');
    await enterEditMode(frame);
    await selectCarpetTool(frame);
    await selectCarpetVariant(frame, 0);

    // The junction (c+1, r+1) sees four tiles: NW=(c,r)=1, NE=(c+1,r)=2,
    // SW=(c,r+1)=8, SE=(c+1,r+1)=4. Paint them one at a time and watch the bits.
    const c = 3;
    const r = 3;
    const jx = c + 1;
    const jy = r + 1;

    narrator.step('painting the NW corner of the junction');
    await paintTile(frame, c, r); // NW
    await waitForCarpetCount(frame, 1);
    expect(await readCarpetJunctionCase(frame, jx, jy, 0)).toBe(1);
    narrator.check('junction bitmask = 1 (NW only)');

    narrator.step('painting the NE corner');
    await paintTile(frame, c + 1, r); // + NE
    await waitForCarpetCount(frame, 2);
    expect(await readCarpetJunctionCase(frame, jx, jy, 0)).toBe(1 | 2);
    narrator.check('bitmask grows to 3 (NW + NE)');

    narrator.step('painting the SW corner');
    await paintTile(frame, c, r + 1); // + SW
    await waitForCarpetCount(frame, 3);
    expect(await readCarpetJunctionCase(frame, jx, jy, 0)).toBe(1 | 2 | 8);
    narrator.check('bitmask grows to 11 (NW + NE + SW)');

    narrator.step('painting the SE corner — fully surrounding the junction');
    await paintTile(frame, c + 1, r + 1); // + SE → fully surrounded
    await waitForCarpetCount(frame, 4);
    expect(await readCarpetJunctionCase(frame, jx, jy, 0)).toBe(15);
    narrator.check('bitmask = 15 — all four corners present');
  });

  test('erasing removes a carpet tile @area:carpet', async ({ pixelAgents }) => {
    const { frame, narrator } = pixelAgents;
    narrator.step('opening the layout editor and selecting the carpet tool');
    await enterEditMode(frame);
    await selectCarpetTool(frame);
    await selectCarpetVariant(frame, 0);

    narrator.step('painting a carpet tile at (5,5)');
    await paintTile(frame, 5, 5);
    await waitForCarpetCount(frame, 1);
    narrator.check('one carpet tile on the canvas');

    narrator.step('erasing (5,5) via the right-drag erase path');
    // Right-drag erase path routes CARPET_PAINT → eraseCarpet (useEditorActions).
    await frame.evaluate(
      ([col, row]) =>
        (window as TestHooksWindow).__pixelAgentsTestHooks?.editorEraseAction?.(col, row),
      [5, 5] as const,
    );
    await waitForCarpetCount(frame, 0);
    narrator.check('carpet tile count back to 0 — the tile was erased');
  });

  test('the carpet eyedropper copies a tile’s variant @area:carpet', async ({ pixelAgents }) => {
    const { frame, narrator } = pixelAgents;
    narrator.step('opening the layout editor and selecting the carpet tool');
    await enterEditMode(frame);
    await selectCarpetTool(frame);

    // Paint a variant-1 tile, then switch the active variant to 0.
    narrator.step('painting a variant-1 carpet tile at (6,6)');
    await selectCarpetVariant(frame, 1);
    await paintTile(frame, 6, 6);
    await waitForCarpetCount(frame, 1);
    narrator.check('one variant-1 tile on the canvas');
    narrator.step('switching the active variant to 0');
    await selectCarpetVariant(frame, 0);

    // Pick the variant-1 tile (CARPET_PICK auto-reverts to CARPET_PAINT), then
    // paint a fresh tile — it must inherit the picked variant (1), not 0.
    narrator.step('eyedropping the variant-1 tile, then painting a fresh tile at (8,8)');
    await selectCarpetPickTool(frame);
    await paintTile(frame, 6, 6); // pick
    await paintTile(frame, 8, 8); // paint with picked variant
    await waitForCarpetCount(frame, 2);

    const tiles = await readCarpetTiles(frame);
    expect(tiles).toContainEqual({ col: 8, row: 8, variant: 1 });
    narrator.check('new tile inherited variant 1 — the eyedropper overrode the active selection');
  });

  test('a carpet stroke is a single undo entry @area:carpet', async ({ pixelAgents }) => {
    const { frame, narrator } = pixelAgents;
    narrator.step('opening the layout editor and selecting the carpet tool');
    await enterEditMode(frame);
    await selectCarpetTool(frame);
    await selectCarpetVariant(frame, 0);

    // Two tiles painted without an intervening mouse-up are one stroke; a single
    // Undo restores the pre-stroke layout (both tiles gone).
    narrator.step('painting two carpet tiles in one continuous stroke');
    await paintTile(frame, 2, 2);
    await paintTile(frame, 2, 3);
    await waitForCarpetCount(frame, 2);
    narrator.check('two carpet tiles from the single stroke');

    narrator.step('clicking Undo once');
    await frame.locator('button', { hasText: 'Undo' }).click();
    await waitForCarpetCount(frame, 0);
    narrator.check('count drops 2 → 0 — the whole stroke is one undo entry');
  });

  test('carpet tiles persist across a save + panel reload @area:carpet', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, narrator } = pixelAgents;

    narrator.step('opening the layout editor → carpet tool');
    await enterEditMode(frame);
    await selectCarpetTool(frame);
    await selectCarpetVariant(frame, 0);

    narrator.step('painting carpet tiles at (4,4) and (9,9)');
    await paintTile(frame, 4, 4);
    await paintTile(frame, 9, 9);
    await waitForCarpetCount(frame, 2);
    narrator.check('two carpet tiles recorded (getCarpetTiles → 2)');

    narrator.step('clicking Save — persisting the layout to disk');
    await saveLayout(frame);

    // The save round-trips through layoutPersistence to the isolated HOME.
    const layoutPath = path.join(tmpHome, '.pixel-agents', 'layout.json');
    await expect
      .poll(
        () => {
          if (!fs.existsSync(layoutPath)) return -1;
          try {
            const parsed = JSON.parse(fs.readFileSync(layoutPath, 'utf8')) as {
              carpetTiles?: Array<unknown | null>;
            };
            return Array.isArray(parsed.carpetTiles)
              ? parsed.carpetTiles.filter((t) => t !== null).length
              : -1;
          } catch {
            return -1;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(2);
    narrator.check('~/.pixel-agents/layout.json contains 2 carpet tiles');

    // Reload the panel and confirm the carpet rehydrates from disk. The
    // reopen uses the same ⌘J chord closeBottomPanel used, so the reload is
    // visible in the video with no palette overlays (see the pets test).
    narrator.step('closing the bottom panel — the webview is disposed');
    await closeBottomPanel(window);
    narrator.step('reopening the panel — carpet must rehydrate from disk');
    await reopenBottomPanel(window);
    const freshFrame = await getPixelAgentsFrame(window);
    await freshFrame.waitForFunction(
      () =>
        ((window as TestHooksWindow).__pixelAgentsTestHooks?.getCarpetTiles?.() ?? []).length === 2,
      undefined,
      { timeout: 15_000 },
    );
    narrator.check('fresh webview shows 2 carpet tiles again — persisted across the reload');
  });

  // 'the Carpet controls live inside the Furniture panel' was removed in the
  // 2026-07 review (Pablo's verdict): redundant — selectCarpetTool transits the
  // same "Paint carpets" button in every carpet test and the thumbnail is
  // asserted in the sprites-load test above — and it pinned internal UI
  // arrangement (carpet-as-Furniture-category, c917772), which a harmless
  // redesign could move without breaking user-facing behavior.
});

const DEFAULT_LAYOUT_PATH = path.join(
  __dirname,
  '../../../../webview-ui/public/assets/default-layout-1.json',
);

/** A valid furniture type from the bundled default layout (for the surface-placement seed). */
function firstDefaultFurnitureType(): string {
  const parsed = JSON.parse(fs.readFileSync(DEFAULT_LAYOUT_PATH, 'utf8')) as {
    furniture?: Array<{ type: string }>;
  };
  const type = parsed.furniture?.[0]?.type;
  if (!type)
    throw new Error('No furniture in bundled default layout to seed surface-placement test');
  return type;
}

// Seed the surface-placement test with a carpet + furniture sharing tile (3,3).
test.describe('Carpet surface placement (seeded)', () => {
  test.use({
    seedLayout: (() => {
      const layout = buildSeedLayout({
        cols: 12,
        rows: 12,
        carpetTiles: [{ col: 3, row: 3, variant: 0 }],
      });
      layout.furniture = [{ uid: 'seed-desk', type: firstDefaultFurnitureType(), col: 3, row: 3 }];
      return layout;
    })(),
  });

  test('a seeded carpet coexists with furniture on the same tile @area:carpet', async ({
    pixelAgents,
  }) => {
    const { frame, narrator } = pixelAgents;
    narrator.step('loading a seeded layout with carpet + furniture sharing tile (3,3)');
    // Carpet tile (3,3) loaded.
    await frame.waitForFunction(
      () => {
        const tiles = (window as TestHooksWindow).__pixelAgentsTestHooks?.getCarpetTiles?.() ?? [];
        return tiles.some((t) => t.col === 3 && t.row === 3);
      },
      undefined,
      { timeout: 15_000 },
    );
    narrator.check('carpet tile present at (3,3) after load');
    // Furniture also present (not blocked by the carpet).
    const furnitureCount = await frame.evaluate(
      () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getFurnitureCount?.() ?? 0,
    );
    expect(furnitureCount).toBeGreaterThanOrEqual(1);
    narrator.check('furniture also survived — at least one item on the same tile');
  });
});
