import fs from 'node:fs';
import path from 'node:path';

import type { Frame, Page } from '@playwright/test';

import { expect, test } from '../../../fixtures/pixel-agents';
import {
  addArea,
  enterEditMode,
  exitEditMode,
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
import { addAgentForDirectory } from '../../../helpers/internal-agent';
import { buildSeedConfig, buildSeedLayout } from '../../../helpers/layout-seed';
import {
  addDirectory,
  getDirectoryAreas,
  getDirectoryModal,
  getPixelAgentsFrame,
  openLaunchDrawer,
  openPixelAgentsPanel,
  submitDirectoryModal,
} from '../../../helpers/webview';

/**
 * Multi-root e2e coverage for Areas — the lane where the Areas editor + the
 * folder→area→seat-preference loop are reachable (the Areas button and the
 * Directory-mapping panel are gated on directories > 1; agents only get a
 * directoryName in a multi-root workspace — adapters/vscode/agentManager.ts).
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
    (n) => ((window as TestHooksWindow).__pixelAgentsTestHooks?.getAreaTiles?.() ?? []).length >= n,
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

test.describe('Areas (multi-root)', () => {
  test.use({ workspaceFolders: [ALPHA, BETA] });

  test('painting an area labels tiles in the layout @area:areas', async ({ pixelAgents }) => {
    const { frame, narrator } = pixelAgents;
    narrator.step('opening the Areas editor and adding an "Engineering" area');
    await startArea(frame, 'Engineering');

    // Paint over real (floor) seat tiles discovered from the layout — area
    // painting is gated to non-VOID/non-WALL tiles (useEditorActions.ts).
    const seats = await readSeats(frame);
    const targets = seats.slice(0, 2);
    expect(targets.length).toBeGreaterThan(0);
    narrator.step('painting Engineering over two real seat tiles');
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
    narrator.check('both painted tiles are labeled "Engineering"');
  });

  test('areas can be added and removed @area:areas', async ({ pixelAgents }) => {
    const { frame, narrator } = pixelAgents;
    narrator.step('opening the layout editor → Areas tool');
    await enterEditMode(frame);
    await selectAreaTool(frame);

    narrator.step('adding a "Design" area');
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
    narrator.check('"Design" appears in the areas list');

    // Remove it via the card's × button.
    narrator.step('removing "Design" with its card\'s × button');
    await frame.locator('button[title="Remove area"]').first().click();
    await frame.waitForFunction(
      () =>
        !((window as TestHooksWindow).__pixelAgentsTestHooks?.getAreas?.() ?? []).some(
          (a) => a.label === 'Design',
        ),
      undefined,
      { timeout: 10_000 },
    );
    narrator.check('"Design" is gone from the areas list');
  });

  test('a folder can be mapped to an area and the mapping persists @area:areas', async ({
    pixelAgents,
  }) => {
    const { frame, narrator } = pixelAgents;
    narrator.step('opening the layout editor → Areas tool');
    await enterEditMode(frame);
    await selectAreaTool(frame);
    narrator.step('adding an "Engineering" area');
    await addArea(frame, 'Engineering');

    // Open the area card's "Add folder…" menu and map the alpha folder.
    narrator.step('opening Engineering\'s "Map a folder…" menu and picking alpha');
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
    narrator.check('the alpha folder now maps to "Engineering"');
  });

  /**
   * Seat-preference relies on a PERSISTED area: spawning an agent opens a
   * terminal that takes over the panel and disposes the webview, so the area
   * must be saved and the panel re-acquired afterward (same reload pattern the
   * pets persistence test uses). areaMappings is seeded so Stage 1 has labels.
   */
  test.describe('seat preference (alpha → Engineering)', () => {
    test.use({ seedConfig: buildSeedConfig({ areaMappings: { [ALPHA]: ['Engineering'] } }) });

    test('an agent for the MAPPED folder takes a seat inside its area @area:areas', async ({
      pixelAgents,
    }) => {
      const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;
      narrator.step('painting Engineering over free seats and saving the layout');
      await paintAndSaveEngineering(frame);

      // Spawn alpha (mapped → Engineering). The terminal takes the panel, so
      // re-acquire the webview; the restored agent re-seats via findFreeSeat with
      // the persisted area + mapping → an Engineering seat.
      await addAgentForDirectory(frame, ALPHA, tmpHome, mockLogFile);
      narrator.step('re-opening the panel — the spawned terminal disposed the webview');
      const fresh = await reacquireFrame(window);

      narrator.step('expecting the restored alpha agent to re-seat inside Engineering');
      await fresh.waitForFunction(
        (folder) =>
          ((window as TestHooksWindow).__pixelAgentsTestHooks?.getAgentSeats?.() ?? []).some(
            (a) => a.directoryName === folder && a.seatId !== null,
          ),
        ALPHA,
        { timeout: 20_000 },
      );
      const agentSeats = await readAgentSeats(fresh);
      const alphaAgent = agentSeats.find((a) => a.directoryName === ALPHA);
      expect(alphaAgent?.areaLabel).toBe('Engineering');
      narrator.check(
        'the alpha agent\'s seat is labeled "Engineering" — steered into its mapped area',
      );
    });

    test('an agent for an UNMAPPED folder is not forced into the area @area:areas', async ({
      pixelAgents,
    }) => {
      const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;
      narrator.step('painting Engineering over free seats and saving the layout');
      await paintAndSaveEngineering(frame);

      // beta is NOT in areaMappings → Stage 1 is skipped → it lands on an unzoned
      // seat, never inside Engineering.
      await addAgentForDirectory(frame, BETA, tmpHome, mockLogFile);
      narrator.step('re-opening the panel after spawning the beta agent');
      const fresh = await reacquireFrame(window);

      narrator.step('expecting the unmapped beta agent to land on an unzoned seat');
      await fresh.waitForFunction(
        (folder) =>
          ((window as TestHooksWindow).__pixelAgentsTestHooks?.getAgentSeats?.() ?? []).some(
            (a) => a.directoryName === folder && a.seatId !== null,
          ),
        BETA,
        { timeout: 20_000 },
      );
      const agentSeats = await readAgentSeats(fresh);
      const betaAgent = agentSeats.find((a) => a.directoryName === BETA);
      expect(betaAgent?.areaLabel).not.toBe('Engineering');
      narrator.check(
        'the beta agent\'s seat is NOT "Engineering" — an unmapped folder is not forced in',
      );
    });
  });

  /**
   * The same Directory→Area mapping, written from the Directory modal instead of
   * the Areas editor: assigning Areas while defining a launch target, which is
   * the only path a phone user has to it.
   *
   * The Directory is deliberately named differently from its path's basename
   * ("Gamma Project" at .../gamma): the loop only closes if the agent's origin
   * label is the NAME — which is what the mapping is keyed by — rather than the
   * directory the path happens to end in.
   */
  test.describe('Area assignment from the Directory modal', () => {
    const GAMMA_NAME = 'Gamma Project';

    test('a Directory assigned an Area in its modal seats the agent it launches inside that Area @area:areas', async ({
      pixelAgents,
    }) => {
      const { frame, window, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;

      narrator.step('painting Engineering over free seats and saving the layout');
      await paintAndSaveEngineering(frame);
      await exitEditMode(frame);

      const target = path.join(workspaceDir, 'gamma');
      fs.mkdirSync(target, { recursive: true });

      narrator.step(`defining "${GAMMA_NAME}" with Engineering ticked in its modal`);
      await addDirectory(frame, { name: GAMMA_NAME, path: target, areas: ['Engineering'] });

      await frame.waitForFunction(
        (name) => {
          const m = (window as TestHooksWindow).__pixelAgentsTestHooks?.getAreaMappings?.() ?? {};
          return (m[name] ?? []).includes('Engineering');
        },
        GAMMA_NAME,
        { timeout: 10_000 },
      );
      narrator.check('the modal wrote the same mapping the Areas editor writes');

      await addAgentForDirectory(frame, GAMMA_NAME, tmpHome, mockLogFile);
      narrator.step('re-opening the panel — the spawned terminal disposed the webview');
      const fresh = await reacquireFrame(window);

      narrator.step(`expecting the restored "${GAMMA_NAME}" agent to sit inside Engineering`);
      await fresh.waitForFunction(
        (name) =>
          ((window as TestHooksWindow).__pixelAgentsTestHooks?.getAgentSeats?.() ?? []).some(
            (a) => a.directoryName === name && a.seatId !== null,
          ),
        GAMMA_NAME,
        { timeout: 20_000 },
      );
      const agentSeats = await readAgentSeats(fresh);
      const gammaAgent = agentSeats.find((a) => a.directoryName === GAMMA_NAME);
      expect(gammaAgent?.areaLabel).toBe('Engineering');
      narrator.check(
        'the agent carries the Directory name as its origin and sits in the Area assigned to it',
      );
    });

    /** No launch here, so no seats are needed — a seeded Area is all the
     *  multi-select needs to have something to assign. */
    test.describe('rename', () => {
      test.use({
        seedLayout: buildSeedLayout({ areas: [{ label: 'Engineering', color: '#6030ff' }] }),
      });

      test('renaming a Directory carries its Area mapping to the new name @area:areas', async ({
        pixelAgents,
      }) => {
        const { frame, workspaceDir, narrator } = pixelAgents;

        const target = path.join(workspaceDir, 'gamma');
        fs.mkdirSync(target, { recursive: true });
        narrator.step(`defining "${GAMMA_NAME}" with Engineering ticked in its modal`);
        await addDirectory(frame, { name: GAMMA_NAME, path: target, areas: ['Engineering'] });

        narrator.step(`renaming "${GAMMA_NAME}" to "Gamma Renamed" through its pencil`);
        await (
          await openLaunchDrawer(frame)
        )
          .getByRole('button', { name: `Edit ${GAMMA_NAME}` })
          .click();
        const modal = getDirectoryModal(frame);
        await expect(modal).toBeVisible();
        // Re-opening shows the assignment it was saved with still ticked.
        await expect(
          getDirectoryAreas(modal).getByRole('button', { name: 'Engineering', exact: true }),
        ).toHaveAttribute('aria-pressed', 'true');
        await submitDirectoryModal(modal, { name: 'Gamma Renamed', path: target });
        await expect(modal).toBeHidden();

        // The seating arrangement follows the rename: the mapping moves to the
        // new name instead of being orphaned under the old one.
        await frame.waitForFunction(
          () => {
            const m = (window as TestHooksWindow).__pixelAgentsTestHooks?.getAreaMappings?.() ?? {};
            return (m['Gamma Renamed'] ?? []).includes('Engineering');
          },
          undefined,
          { timeout: 10_000 },
        );
        const mappings = await frame.evaluate(
          () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getAreaMappings?.() ?? {},
        );
        expect(mappings[GAMMA_NAME]).toBeUndefined();
        narrator.check('the mapping moved with the name — no orphan under the old one');
      });
    });
  });
});
