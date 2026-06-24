import fs from 'fs';
import path from 'path';

import type { Frame } from '@playwright/test';

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
import {
  closeBottomPanel,
  getPixelAgentsFrame,
  openPixelAgentsPanel,
} from '../../../helpers/webview';

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
    const { frame } = pixelAgents;

    // carpetTilesLoaded is sent once after webviewReady — proven via the message log.
    await frame.waitForFunction(() => {
      const log = (window as TestHooksWindow).__pixelAgentsTestHooks?.messageLog ?? [];
      return log.some((m) => m.type === 'carpetTilesLoaded');
    });

    await enterEditMode(frame);
    await selectCarpetTool(frame);
    // At least one carpet variant thumbnail renders inside the Furniture panel.
    await expect(frame.locator(CARPET_THUMB(0))).toBeVisible({ timeout: 15_000 });
  });

  test('painting a tile records it in the carpet layer @area:carpet', async ({ pixelAgents }) => {
    const { frame } = pixelAgents;
    await enterEditMode(frame);
    await selectCarpetTool(frame);
    await selectCarpetVariant(frame, 0);

    await paintTile(frame, 4, 4);
    await waitForCarpetCount(frame, 1);

    const tiles = await readCarpetTiles(frame);
    expect(tiles).toContainEqual({ col: 4, row: 4, variant: 0 });
  });

  test('autotiling: the junction case reflects neighboring carpet tiles @area:carpet', async ({
    pixelAgents,
  }) => {
    const { frame } = pixelAgents;
    await enterEditMode(frame);
    await selectCarpetTool(frame);
    await selectCarpetVariant(frame, 0);

    // The junction (c+1, r+1) sees four tiles: NW=(c,r)=1, NE=(c+1,r)=2,
    // SW=(c,r+1)=8, SE=(c+1,r+1)=4. Paint them one at a time and watch the bits.
    const c = 3;
    const r = 3;
    const jx = c + 1;
    const jy = r + 1;

    await paintTile(frame, c, r); // NW
    await waitForCarpetCount(frame, 1);
    expect(await readCarpetJunctionCase(frame, jx, jy, 0)).toBe(1);

    await paintTile(frame, c + 1, r); // + NE
    await waitForCarpetCount(frame, 2);
    expect(await readCarpetJunctionCase(frame, jx, jy, 0)).toBe(1 | 2);

    await paintTile(frame, c, r + 1); // + SW
    await waitForCarpetCount(frame, 3);
    expect(await readCarpetJunctionCase(frame, jx, jy, 0)).toBe(1 | 2 | 8);

    await paintTile(frame, c + 1, r + 1); // + SE → fully surrounded
    await waitForCarpetCount(frame, 4);
    expect(await readCarpetJunctionCase(frame, jx, jy, 0)).toBe(15);
  });

  test('erasing removes a carpet tile @area:carpet', async ({ pixelAgents }) => {
    const { frame } = pixelAgents;
    await enterEditMode(frame);
    await selectCarpetTool(frame);
    await selectCarpetVariant(frame, 0);

    await paintTile(frame, 5, 5);
    await waitForCarpetCount(frame, 1);

    // Right-drag erase path routes CARPET_PAINT → eraseCarpet (useEditorActions).
    await frame.evaluate(
      ([col, row]) =>
        (window as TestHooksWindow).__pixelAgentsTestHooks?.editorEraseAction?.(col, row),
      [5, 5] as const,
    );
    await waitForCarpetCount(frame, 0);
  });

  test('the carpet eyedropper copies a tile’s variant @area:carpet', async ({ pixelAgents }) => {
    const { frame } = pixelAgents;
    await enterEditMode(frame);
    await selectCarpetTool(frame);

    // Paint a variant-1 tile, then switch the active variant to 0.
    await selectCarpetVariant(frame, 1);
    await paintTile(frame, 6, 6);
    await waitForCarpetCount(frame, 1);
    await selectCarpetVariant(frame, 0);

    // Pick the variant-1 tile (CARPET_PICK auto-reverts to CARPET_PAINT), then
    // paint a fresh tile — it must inherit the picked variant (1), not 0.
    await selectCarpetPickTool(frame);
    await paintTile(frame, 6, 6); // pick
    await paintTile(frame, 8, 8); // paint with picked variant
    await waitForCarpetCount(frame, 2);

    const tiles = await readCarpetTiles(frame);
    expect(tiles).toContainEqual({ col: 8, row: 8, variant: 1 });
  });

  test('a carpet stroke is a single undo entry @area:carpet', async ({ pixelAgents }) => {
    const { frame } = pixelAgents;
    await enterEditMode(frame);
    await selectCarpetTool(frame);
    await selectCarpetVariant(frame, 0);

    // Two tiles painted without an intervening mouse-up are one stroke; a single
    // Undo restores the pre-stroke layout (both tiles gone).
    await paintTile(frame, 2, 2);
    await paintTile(frame, 2, 3);
    await waitForCarpetCount(frame, 2);

    await frame.locator('button', { hasText: 'Undo' }).click();
    await waitForCarpetCount(frame, 0);
  });

  test('carpet tiles persist across a save + panel reload @area:carpet', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome } = pixelAgents;
    await enterEditMode(frame);
    await selectCarpetTool(frame);
    await selectCarpetVariant(frame, 0);

    await paintTile(frame, 4, 4);
    await paintTile(frame, 9, 9);
    await waitForCarpetCount(frame, 2);
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

    // Reload the panel and confirm the carpet rehydrates from disk.
    await closeBottomPanel(window);
    await openPixelAgentsPanel(window);
    const freshFrame = await getPixelAgentsFrame(window);
    await freshFrame.waitForFunction(
      () =>
        ((window as TestHooksWindow).__pixelAgentsTestHooks?.getCarpetTiles?.() ?? []).length === 2,
      undefined,
      { timeout: 15_000 },
    );
  });

  test('the Carpet controls live inside the Furniture panel @area:carpet', async ({
    pixelAgents,
  }) => {
    const { frame } = pixelAgents;
    await enterEditMode(frame);
    await selectCarpetTool(frame);

    // The "Paint carpets" category button + variant thumbnails render together
    // (carpet is a category within Furniture, not a top-level tool — c917772).
    await expect(frame.locator('button[title="Paint carpets"]')).toBeVisible();
    await expect(frame.locator(CARPET_THUMB(0))).toBeVisible();
  });
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
    const { frame } = pixelAgents;
    // Carpet tile (3,3) loaded.
    await frame.waitForFunction(
      () => {
        const tiles = (window as TestHooksWindow).__pixelAgentsTestHooks?.getCarpetTiles?.() ?? [];
        return tiles.some((t) => t.col === 3 && t.row === 3);
      },
      undefined,
      { timeout: 15_000 },
    );
    // Furniture also present (not blocked by the carpet).
    const furnitureCount = await frame.evaluate(
      () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getFurnitureCount?.() ?? 0,
    );
    expect(furnitureCount).toBeGreaterThanOrEqual(1);
  });
});
