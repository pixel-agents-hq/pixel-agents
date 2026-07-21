import { expect, test } from '../../../fixtures/pixel-agents';
import {
  enterEditMode,
  readAreas,
  readAreaTiles,
  type TestHooksWindow,
} from '../../../helpers/editor';
import { buildSeedConfig, buildSeedLayout } from '../../../helpers/layout-seed';

/**
 * Single-folder e2e coverage for Areas.
 *
 * The Areas EDITOR (paint tool, CRUD, folder mapping) is gated on
 * workspaceFolders > 0 (EditorToolbar.tsx) and the Show Areas settings toggle on
 * the same gate (App.tsx), so a single-folder window cannot reach them — those
 * are covered in areas-multiroot.spec.ts. What a single folder CAN verify:
 *   - seeded area data loads into OfficeState (areas + areaTiles round-trip), and
 *   - the seeded showAreas state drives the effective overlay gate, and
 *   - the Areas tool button is correctly hidden without workspace folders.
 * Area overlay/labels are canvas-only, so we assert state, not pixels (the same
 * tradeoff the pets fixture makes).
 */

test.describe('Areas (single-folder)', () => {
  test.describe('seeded area data + show-areas state', () => {
    test.use({
      seedConfig: buildSeedConfig({ showAreas: true }),
      seedLayout: buildSeedLayout({
        cols: 10,
        rows: 10,
        areas: [{ label: 'Engineering', color: '#ff6b6b' }],
        areaTiles: [
          { col: 2, row: 2, label: 'Engineering' },
          { col: 3, row: 2, label: 'Engineering' },
        ],
      }),
    });

    test('seeded areas + areaTiles load and showAreas is effective @area:areas', async ({
      pixelAgents,
    }) => {
      const { frame, narrator } = pixelAgents;

      narrator.step('layout seeded with one "Engineering" area (two tiles) and showAreas on');

      // Area definitions + painted tiles survive the layout load.
      narrator.step('waiting for the seeded "Engineering" area to load into the office');
      await frame.waitForFunction(
        () => ((window as TestHooksWindow).__pixelAgentsTestHooks?.getAreas?.() ?? []).length === 1,
        undefined,
        { timeout: 15_000 },
      );
      const areas = await readAreas(frame);
      expect(areas).toContainEqual({ label: 'Engineering', color: '#ff6b6b' });
      narrator.check('the "Engineering" area round-tripped (color #ff6b6b)');

      const areaTiles = await readAreaTiles(frame);
      expect(areaTiles).toContainEqual({ col: 2, row: 2, label: 'Engineering' });
      expect(areaTiles).toContainEqual({ col: 3, row: 2, label: 'Engineering' });
      narrator.check('both painted tiles present — (2,2) and (3,2)');

      // The seeded showAreas:true makes the overlay gate effective.
      const showAreas = await frame.evaluate(
        () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getShowAreas?.() ?? false,
      );
      expect(showAreas).toBe(true);
      narrator.check('seeded showAreas:true is effective — the overlay gate is on');
    });
  });

  test('the Areas tool button is hidden without workspace folders @area:areas', async ({
    pixelAgents,
  }) => {
    const { frame, narrator } = pixelAgents;
    narrator.step('opening the layout editor with no workspace folders configured');
    await enterEditMode(frame);
    // Single-folder fixture sends no workspaceFolders → the Areas button is gated off.
    await expect(frame.locator('button[title*="Define folder-bound areas"]')).toHaveCount(0);
    narrator.check('no Areas tool button — the tool is gated on having folders to map');
  });

  test.describe('seeded areas layout (positive gate)', () => {
    test.use({
      seedLayout: buildSeedLayout({
        areas: [{ label: 'Engineering', color: '#ff6b6b' }],
        areaTiles: [{ col: 2, row: 2, label: 'Engineering' }],
      }),
    });

    test('the Areas tool button is visible with a seeded areas layout @area:areas', async ({
      pixelAgents,
    }) => {
      const { frame, narrator } = pixelAgents;
      narrator.step('opening the seeded layout editor to check the Areas tool gate');
      await enterEditMode(frame);
      // areasAvailable is now (layout.areas?.length ?? 0) > 0 || <folders>, so a
      // seeded single-folder layout with areas makes the button visible even
      // without workspace folders.
      await expect(frame.locator('button[title*="Define folder-bound areas"]')).toHaveCount(1);
      narrator.check('the Areas tool button is visible because the seeded layout has an area');
    });
  });
});
