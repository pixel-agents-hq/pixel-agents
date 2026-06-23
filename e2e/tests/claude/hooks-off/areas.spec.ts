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
      const { frame } = pixelAgents;

      // Area definitions + painted tiles survive the layout load.
      await frame.waitForFunction(
        () => ((window as TestHooksWindow).__pixelAgentsTestHooks?.getAreas?.() ?? []).length === 1,
        undefined,
        { timeout: 15_000 },
      );
      const areas = await readAreas(frame);
      expect(areas).toContainEqual({ label: 'Engineering', color: '#ff6b6b' });

      const areaTiles = await readAreaTiles(frame);
      expect(areaTiles).toContainEqual({ col: 2, row: 2, label: 'Engineering' });
      expect(areaTiles).toContainEqual({ col: 3, row: 2, label: 'Engineering' });

      // The seeded showAreas:true makes the overlay gate effective.
      const showAreas = await frame.evaluate(
        () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getShowAreas?.() ?? false,
      );
      expect(showAreas).toBe(true);
    });
  });

  test('the Areas tool button is hidden without workspace folders @area:areas', async ({
    pixelAgents,
  }) => {
    const { frame } = pixelAgents;
    await enterEditMode(frame);
    // Single-folder fixture sends no workspaceFolders → the Areas button is gated off.
    await expect(frame.locator('button[title*="Define folder-bound areas"]')).toHaveCount(0);
  });
});
