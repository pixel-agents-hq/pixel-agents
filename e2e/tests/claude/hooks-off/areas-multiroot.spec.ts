import type { Frame, Page } from '@playwright/test';

import { expect, test } from '../../../fixtures/pixel-agents';
import {
  addArea,
  enterEditMode,
  paintTile,
  readAgentSeats,
  readAreas,
  readAreaTiles,
  readSeats,
  saveLayout,
  selectArea,
  selectAreaTool,
  type TestHooksWindow,
} from '../../../helpers/editor';
import { addAgentForFolder } from '../../../helpers/internal-agent';
import { buildSeedConfig } from '../../../helpers/layout-seed';
import { getPixelAgentsFrame, openPixelAgentsPanel } from '../../../helpers/webview';

/**
 * Multi-root e2e coverage for Areas — the lane where the Areas editor + the
 * folder→area→seat-preference loop are reachable (the Areas button and the
 * folder-mapping panel are gated on workspaceFolders > 1; agents only get a
 * folderName in a multi-root workspace — adapters/vscode/agentManager.ts).
 *
 * The fixture opens a generated multi-root workspace with folders "alpha" and
 * "beta" (see e2e/helpers/launch.ts). The bundled default layout (which has
 * seats) loads; specs discover seat coordinates via the getSeats hook rather
 * than hardcoding layout positions. Seat-preference is asserted by AREA
 * MEMBERSHIP (the seated agent's area === the mapped label), which is invariant
 * under findFreeSeat's PC-bias randomness.
 */

const ALPHA = 'alpha';
const BETA = 'beta';

/** Enter the Areas editor and add + select an area in one go. */
async function startArea(frame: Frame, label: string): Promise<void> {
  await enterEditMode(frame);
  await selectAreaTool(frame);
  await addArea(frame, label);
  await selectArea(frame, label);
}

test.describe('Areas (multi-root)', () => {
  test.use({ workspaceFolders: [ALPHA, BETA] });

  test('painting an area labels tiles in the layout @area:areas', async ({ pixelAgents }) => {
    const { frame } = pixelAgents;
    await startArea(frame, 'Engineering');

    // Paint over real (floor) seat tiles discovered from the layout — area
    // painting is gated to non-VOID/non-WALL tiles (useEditorActions.ts).
    const seats = await readSeats(frame);
    const targets = seats.slice(0, 2);
    expect(targets.length).toBeGreaterThan(0);
    for (const s of targets) {
      await paintTile(frame, s.col, s.row);
    }

    await frame.waitForFunction(
      (n) =>
        ((window as TestHooksWindow).__pixelAgentsTestHooks?.getAreaTiles?.() ?? []).length >= n,
      targets.length,
      { timeout: 10_000 },
    );
    const areaTiles = await readAreaTiles(frame);
    for (const s of targets) {
      expect(areaTiles).toContainEqual({ col: s.col, row: s.row, label: 'Engineering' });
    }
  });

  test('areas can be added and removed @area:areas', async ({ pixelAgents }) => {
    const { frame } = pixelAgents;
    await enterEditMode(frame);
    await selectAreaTool(frame);

    await addArea(frame, 'Design');
    await frame.waitForFunction(
      () =>
        ((window as TestHooksWindow).__pixelAgentsTestHooks?.getAreas?.() ?? []).some(
          (a) => a.label === 'Design',
        ),
      undefined,
      { timeout: 10_000 },
    );
    expect(await readAreas(frame)).toContainEqual(expect.objectContaining({ label: 'Design' }));

    // Remove it via the card's × button.
    await frame.locator('button[title="Remove area"]').first().click();
    await frame.waitForFunction(
      () =>
        !((window as TestHooksWindow).__pixelAgentsTestHooks?.getAreas?.() ?? []).some(
          (a) => a.label === 'Design',
        ),
      undefined,
      { timeout: 10_000 },
    );
  });

  test('a folder can be mapped to an area and the mapping persists @area:areas', async ({
    pixelAgents,
  }) => {
    const { frame } = pixelAgents;
    await enterEditMode(frame);
    await selectAreaTool(frame);
    await addArea(frame, 'Engineering');

    // Open the area card's "Add folder…" menu and map the alpha folder.
    await frame.locator('button[title*="Map a folder"]').first().click();
    await frame.getByText(ALPHA, { exact: true }).click();

    await frame.waitForFunction(
      (folder) => {
        const m = (window as TestHooksWindow).__pixelAgentsTestHooks?.getAreaMappings?.() ?? {};
        return (m[folder] ?? []).includes('Engineering');
      },
      ALPHA,
      { timeout: 10_000 },
    );
  });

  /**
   * Seat-preference relies on a PERSISTED area: spawning an agent opens a
   * terminal that takes over the panel and disposes the webview, so the area
   * must be saved and the panel re-acquired afterward (same reload pattern the
   * pets persistence test uses). areaMappings is seeded so Stage 1 has labels.
   */
  test.describe('seat preference (alpha → Engineering)', () => {
    test.use({ seedConfig: buildSeedConfig({ areaMappings: { [ALPHA]: ['Engineering'] } }) });

    /** Add "Engineering", paint it over some real (free) seats, and save. */
    async function paintAndSaveEngineering(frame: Frame): Promise<void> {
      await startArea(frame, 'Engineering');
      const seats = await readSeats(frame);
      const targetSeats = seats.filter((s) => !s.assigned).slice(0, 3);
      expect(targetSeats.length).toBeGreaterThan(0);
      for (const seat of targetSeats) {
        await paintTile(frame, seat.col, seat.row);
      }
      await frame.waitForFunction(
        (n) =>
          ((window as TestHooksWindow).__pixelAgentsTestHooks?.getAreaTiles?.() ?? []).length >= n,
        targetSeats.length,
        { timeout: 10_000 },
      );
      await saveLayout(frame);
    }

    /** Re-open the panel (disposed by the spawned terminal) + return a fresh frame. */
    async function reacquireFrame(window: Page): Promise<Frame> {
      await openPixelAgentsPanel(window);
      return getPixelAgentsFrame(window);
    }

    test('an agent for the MAPPED folder takes a seat inside its area @area:areas', async ({
      pixelAgents,
    }) => {
      const { frame, window, tmpHome, mockLogFile } = pixelAgents;
      await paintAndSaveEngineering(frame);

      // Spawn alpha (mapped → Engineering). The terminal takes the panel, so
      // re-acquire the webview; the restored agent re-seats via findFreeSeat with
      // the persisted area + mapping → an Engineering seat.
      await addAgentForFolder(frame, ALPHA, tmpHome, mockLogFile);
      const fresh = await reacquireFrame(window);

      await fresh.waitForFunction(
        (folder) =>
          ((window as TestHooksWindow).__pixelAgentsTestHooks?.getAgentSeats?.() ?? []).some(
            (a) => a.folderName === folder && a.seatId !== null,
          ),
        ALPHA,
        { timeout: 20_000 },
      );
      const agentSeats = await readAgentSeats(fresh);
      const alphaAgent = agentSeats.find((a) => a.folderName === ALPHA);
      expect(alphaAgent?.areaLabel).toBe('Engineering');
    });

    test('an agent for an UNMAPPED folder is not forced into the area @area:areas', async ({
      pixelAgents,
    }) => {
      const { frame, window, tmpHome, mockLogFile } = pixelAgents;
      await paintAndSaveEngineering(frame);

      // beta is NOT in areaMappings → Stage 1 is skipped → it lands on an unzoned
      // seat, never inside Engineering.
      await addAgentForFolder(frame, BETA, tmpHome, mockLogFile);
      const fresh = await reacquireFrame(window);

      await fresh.waitForFunction(
        (folder) =>
          ((window as TestHooksWindow).__pixelAgentsTestHooks?.getAgentSeats?.() ?? []).some(
            (a) => a.folderName === folder && a.seatId !== null,
          ),
        BETA,
        { timeout: 20_000 },
      );
      const agentSeats = await readAgentSeats(fresh);
      const betaAgent = agentSeats.find((a) => a.folderName === BETA);
      expect(betaAgent?.areaLabel).not.toBe('Engineering');
    });
  });
});
