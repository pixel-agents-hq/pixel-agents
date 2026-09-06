import fs from 'node:fs';
import path from 'node:path';

import type { Frame, Page } from '@playwright/test';

import { expect, test } from '../../../fixtures/pixel-agents';
import { addAgentForDirectory } from '../../../helpers/internal-agent';
import { expectOverlayVisibleWithTexts } from '../../../helpers/office';
import {
  addDirectory,
  getPixelAgentsFrame,
  openLaunchDrawer,
  openPixelAgentsPanel,
} from '../../../helpers/webview';

/**
 * The VS Code launch surface in a multi-root window: the host contributes every
 * workspace folder as a read-only Directory, the launch button's secondary
 * gesture (hover on desktop) opens the drawer over them, and tapping a row
 * launches an agent into that Directory.
 *
 * The fixture opens a generated multi-root workspace with folders "alpha" and
 * "beta" (see e2e/helpers/launch.ts).
 */

const ALPHA = 'alpha';
const BETA = 'beta';
/** Not a workspace folder — a Directory the user defines in the office. */
const GAMMA = 'gamma';

/** Re-open the panel (disposed by the spawned terminal) + return a fresh frame. */
async function reacquireFrame(window: Page): Promise<Frame> {
  await openPixelAgentsPanel(window);
  return getPixelAgentsFrame(window);
}

test.describe('Launch drawer (multi-root)', () => {
  test.use({ workspaceFolders: [ALPHA, BETA] });

  test('hovering + Agent opens a drawer with a badged, read-only row per workspace folder @area:spawn', async ({
    pixelAgents,
  }) => {
    const { frame, narrator } = pixelAgents;

    narrator.step('hovering "+ Agent" — the desktop secondary gesture');
    const drawer = await openLaunchDrawer(frame);

    for (const name of [ALPHA, BETA]) {
      const row = drawer.getByRole('button', { name, exact: true });
      await expect(row).toBeVisible();
      // Host-contributed: badged, and with no nested control to edit it.
      await expect(row.getByText('host', { exact: true })).toBeVisible();
      await expect(row.locator('button')).toHaveCount(0);
    }
    narrator.check('both workspace folders are drawer rows, badged as host-contributed');

    // The per-launch bypass menu the hover gesture used to open is gone: the
    // launch button has exactly one secondary gesture now.
    await expect(frame.getByText('Skip permissions mode')).toHaveCount(0);
    narrator.check('no bypass menu on the launch button — only the Directory drawer');
  });

  test('tapping a drawer row launches an agent labeled with that Directory @area:spawn', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    // Opens the drawer and clicks the "alpha" row, which sends launchAgent with
    // that Directory's path.
    await addAgentForDirectory(frame, ALPHA, tmpHome, mockLogFile);

    narrator.step('re-opening the panel — the spawned terminal disposed the webview');
    const fresh = await reacquireFrame(window);

    narrator.step('expecting the new character to carry "alpha" as its origin label');
    await expectOverlayVisibleWithTexts(fresh, [ALPHA], 20_000);
    narrator.check('the agent launched from the drawer row shows its Directory name');
  });

  test('a Directory defined in the office joins the drawer, launches, and survives a panel reload @area:spawn', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;

    // A real directory outside every workspace folder: what this host could not
    // launch into before, and what the user-defined half of the union is for.
    const target = path.join(workspaceDir, GAMMA);
    fs.mkdirSync(target, { recursive: true });

    narrator.step(`adding "${GAMMA}" through the drawer's + Directory modal`);
    await addDirectory(frame, { name: GAMMA, path: target });

    const drawer = await openLaunchDrawer(frame);
    const row = drawer.getByRole('button', { name: GAMMA, exact: true });
    // User-defined, so it is editable here and carries no host badge — unlike
    // the workspace folders beside it.
    await expect(row.getByText('host', { exact: true })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: `Edit ${GAMMA}` })).toBeVisible();
    narrator.check('the new Directory is an editable, unbadged drawer row');

    await addAgentForDirectory(frame, GAMMA, tmpHome, mockLogFile);

    narrator.step('re-opening the panel — the spawned terminal disposed the webview');
    const fresh = await reacquireFrame(window);
    await expectOverlayVisibleWithTexts(fresh, [GAMMA], 20_000);
    narrator.check('the agent launched into the user-defined Directory carries its name');

    // The fresh webview rebuilds its list from the machine-wide config, not
    // from anything the old iframe held.
    const reloaded = await openLaunchDrawer(fresh);
    await expect(reloaded.getByRole('button', { name: GAMMA, exact: true })).toBeVisible();
    narrator.check('the Directory is still there after the panel reload');
  });
});
