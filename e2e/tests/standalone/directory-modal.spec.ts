import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { buildSeedLayout } from '../../helpers/layout-seed';
import {
  directoryPencil,
  getDirectoryAreas,
  getDirectoryModal,
  openDirectoryModal,
  openLaunchDrawer,
} from '../../helpers/webview';

/**
 * The Directory modal itself: its keyboard contract and the Area mapping it
 * writes. No terminal is involved — nothing here launches — so these run on
 * every platform. The layout is seeded with one Area so the modal's Area
 * multi-select renders.
 */

const AREA = 'Engineering';
const SEEDED_LAYOUT = buildSeedLayout({
  areas: [{ label: AREA, color: '#ff6b6b' }],
  areaTiles: [{ col: 1, row: 1, label: AREA }],
});

interface SharedConfig {
  directories?: Array<{ name: string; path: string }>;
  standalone?: { areaMappings?: Record<string, string[]> };
}

function readSharedConfig(tmpHome: string): SharedConfig {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.pixel-agents', 'config.json'), 'utf8'),
    ) as SharedConfig;
  } catch {
    return {};
  }
}

test.describe('Standalone / Directory modal keyboard', () => {
  test.use({ standaloneOptions: { seedLayout: SEEDED_LAYOUT } });

  test('Enter on Cancel cancels and Enter on an Area toggles it; neither saves @area:standalone', async ({
    page,
    standalone,
  }) => {
    const target = path.join(standalone.workspaceDir, 'never-saved');
    fs.mkdirSync(target, { recursive: true });

    const modal = await openDirectoryModal(page);
    await modal.getByPlaceholder('Project name').fill('Never Saved');
    await modal.getByPlaceholder('~/code/my-project').fill(target);

    // Enter on an Area button is that button's activation: it toggles the Area
    // and leaves the modal open on an unsaved entry.
    const area = getDirectoryAreas(modal).getByRole('button', { name: AREA, exact: true });
    await area.focus();
    await page.keyboard.press('Enter');
    await expect(area).toHaveAttribute('aria-pressed', 'true');
    // Settle: a save, had one been sent, closes the modal a round trip later.
    await page.waitForTimeout(1_000);
    await expect(modal).toBeVisible();

    // Enter on Cancel cancels.
    await modal.getByRole('button', { name: 'Cancel', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(modal).toBeHidden();

    // Settle before the negative assertions: a save, had one been sent, is a
    // round trip to the host.
    await page.waitForTimeout(1_000);
    expect(readSharedConfig(standalone.tmpHome).directories ?? []).toEqual([]);
    const drawer = await openLaunchDrawer(page);
    await expect(drawer.getByRole('button', { name: 'Never Saved', exact: true })).toHaveCount(0);
  });

  test('Enter in the path field saves @area:standalone', async ({ page, standalone }) => {
    const target = path.join(standalone.workspaceDir, 'typed-and-entered');
    fs.mkdirSync(target, { recursive: true });

    const modal = await openDirectoryModal(page);
    await modal.getByPlaceholder('Project name').fill('Typed And Entered');
    const pathField = modal.getByPlaceholder('~/code/my-project');
    await pathField.fill(target);
    await pathField.press('Enter');

    await expect(modal).toBeHidden({ timeout: 15_000 });
    const drawer = await openLaunchDrawer(page);
    await expect(
      drawer.getByRole('button', { name: 'Typed And Entered', exact: true }),
    ).toBeVisible();
  });
});

test.describe('Standalone / Directory Area mapping', () => {
  test.use({ standaloneOptions: { seedLayout: SEEDED_LAYOUT } });

  test('an unnamed Directory keeps its Area under the name the host gave it @area:standalone', async ({
    page,
    standalone,
  }) => {
    // `~` is the isolated HOME; with no name the host names the Directory
    // after the RESOLVED path's basename, which is what launches are labelled
    // with and what seat placement looks the Area mapping up by.
    const hostName = path.basename(standalone.tmpHome);

    const modal = await openDirectoryModal(page);
    await modal.getByPlaceholder('~/code/my-project').fill('~');
    await getDirectoryAreas(modal).getByRole('button', { name: AREA, exact: true }).click();
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(modal).toBeHidden({ timeout: 15_000 });

    await expect
      .poll(() => readSharedConfig(standalone.tmpHome).standalone?.areaMappings ?? {}, {
        timeout: 10_000,
      })
      .toEqual({ [hostName]: [AREA] });

    // Reopened, the entry still shows its Area.
    const drawer = await openLaunchDrawer(page);
    await (await directoryPencil(page, drawer, hostName)).click();
    const reopened = getDirectoryModal(page);
    await expect(reopened).toBeVisible();
    await expect(
      getDirectoryAreas(reopened).getByRole('button', { name: AREA, exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
  });
});
