import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { removeTempDir } from '../../helpers/removeTempDir';

/**
 * A PC opens a PC shell (CONTEXT.md → Interactive Furniture): hovering a PC
 * shows its Furniture label; a click on a PC whose Area has two Directories
 * shows the Directory selector; choosing one starts a login shell there, in the
 * office's own terminal, whose card joins the card bar while the PC's screen
 * plays its "on" state; the card's × asks first while a command runs and ends
 * an idle shell at once, taking the card and the lit screen with it.
 *
 * No agent is involved, so no mock claude: the shell is the host's own, the
 * process boundary is the host's environment (`SHELL=/bin/sh`, so no login
 * shell's first-run prompts get in the way). The office is the bundled default
 * layout, whose front PC at (7,12) stands in its "Studio" Area; two user
 * Directories are mapped to that Area. Canvas-only facts (where the PC is drawn,
 * whether its screen is on) are read through the e2e test hooks, as the pets
 * and editor specs do.
 */

/** A front PC of the bundled default layout, in its "Studio" Area. */
const PC_UID = 'f-1773356781294-b69z';
/** The PC's lower footprint tile (the upper one is a background row). */
const PC_TILE = { col: 7, row: 13 };
const AREA = 'Studio';

// The two Directories must exist before the host starts (it reads config.json
// once), so they are made with the module, beside the fixture's own temp dirs.
const DIRS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-pc-shells-e2e-'));
const ALPHA = path.join(DIRS_ROOT, 'alpha');
const BETA = path.join(DIRS_ROOT, 'beta');
fs.mkdirSync(ALPHA);
fs.mkdirSync(BETA);

const TWO_DIRECTORIES = {
  directories: [
    { name: 'Alpha', path: ALPHA },
    { name: 'Beta', path: BETA },
  ],
  standalone: { showHostDirectories: true, areaMappings: { Alpha: [AREA], Beta: [AREA] } },
};

const PHONE = { width: 390, height: 844 };

type HooksWindow = Window & {
  __pixelAgentsTestHooks?: {
    getTileCenter?: (col: number, row: number) => { x: number; y: number } | null;
    getPieceShownState?: (uid: string) => string | null;
    getFurnitureCount?: () => number;
  };
};

/** Where tile (col,row)'s centre is on the page, through the renderer's own
 *  projection; fails when anything covers it (a click there would miss the canvas). */
async function tilePoint(page: Page, col: number, row: number): Promise<{ x: number; y: number }> {
  const canvas = page.getByTestId('office-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('the office canvas is not rendered');
  const local = await page.evaluate(
    ([c, r]) => {
      const center = (window as HooksWindow).__pixelAgentsTestHooks?.getTileCenter?.(c, r);
      const el = document.querySelector('[data-testid="office-canvas"]');
      if (!center || !el) return null;
      const rect = el.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + center.x, rect.top + center.y);
      return { ...center, onCanvas: top === el };
    },
    [col, row] as const,
  );
  if (!local) throw new Error(`tile (${col},${row}) has no projection yet`);
  if (!local.onCanvas) throw new Error(`tile (${col},${row}) is covered`);
  return { x: box.x + local.x, y: box.y + local.y };
}

/** The same, once the camera has stopped moving: a click on a PC centres the
 *  camera on it, so the PC is somewhere else on the page a moment later. */
async function settledTilePoint(
  page: Page,
  col: number,
  row: number,
): Promise<{ x: number; y: number }> {
  let last = await tilePoint(page, col, row);
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(100);
    const now = await tilePoint(page, col, row);
    if (now.x === last.x && now.y === last.y) return now;
    last = now;
  }
  throw new Error(`tile (${col},${row}) never stopped moving`);
}

/** The state the PC's screen is drawn in ("on"), or null for its usual sprite. */
function pcState(page: Page): Promise<string | null> {
  return page.evaluate(
    (uid) => (window as HooksWindow).__pixelAgentsTestHooks?.getPieceShownState?.(uid) ?? null,
    PC_UID,
  );
}

const label = (page: Page): Locator => page.getByTestId('furniture-label');

test.describe('Standalone / PC shells', () => {
  // The shell runs in the host's PTY, POSIX only like the other terminal specs.
  test.skip(process.platform === 'win32', 'PC shells run through the POSIX PTY path here');
  test.use({ standaloneOptions: { seedConfig: TWO_DIRECTORIES, hostEnv: { SHELL: '/bin/sh' } } });
  test.afterAll(() => removeTempDir(DIRS_ROOT));

  test('hover, the Directory selector, a shell that echoes, its card and lit PC, and × @area:standalone', async ({
    page,
    standalone: _standalone,
  }) => {
    // Hover: the Furniture label says the PC is free (its line alone, no name over it).
    const pc = await tilePoint(page, PC_TILE.col, PC_TILE.row);
    await page.mouse.move(pc.x, pc.y);
    await expect(label(page)).toHaveAttribute('data-piece-uid', PC_UID);
    await expect(page.getByTestId('furniture-label-name')).toHaveCount(0);
    await expect(page.getByTestId('furniture-label-line')).toHaveText('Free');
    expect(await pcState(page)).toBeNull();

    // Click: the PC's Area has two Directories, so the selector asks where.
    await page.mouse.click(pc.x, pc.y);
    const selector = page.getByTestId('pc-directory-selector');
    await expect(selector).toBeVisible();
    // The camera centres on the clicked PC, as it does on a clicked character.
    await expect
      .poll(() => page.evaluate(() => window.__pixelAgentsTestHooks?.getCameraPieceUid?.() ?? null))
      .toBe(PC_UID);
    await expect(selector.getByTestId('pc-directory-option')).toHaveText(['Alpha', 'Beta']);
    await expect(selector).toBeInViewport({ ratio: 1 });

    // Escape dismisses it; a second click brings it back.
    await page.keyboard.press('Escape');
    await expect(selector).toHaveCount(0);
    const pcCentred = await settledTilePoint(page, PC_TILE.col, PC_TILE.row);
    await page.mouse.click(pcCentred.x, pcCentred.y);
    await expect(selector).toBeVisible();

    // Beta: a shell opens there, in the terminal drawer, and its card joins the bar.
    await selector.getByRole('menuitem', { name: 'Beta' }).click();
    await expect(selector).toHaveCount(0);
    const card = page.getByTestId('pc-shell-card');
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId('pc-shell-card-name')).toHaveText('Beta');
    await expect.poll(() => pcState(page)).toBe('on');

    // The terminal is the shell, in Beta: a typed command runs and echoes.
    const terminal = page.locator('.xterm:visible');
    await expect(terminal).toHaveCount(1);
    await terminal.click();
    await page.keyboard.type('echo "pc-$((6*7))-in:$(basename "$PWD")"');
    await page.keyboard.press('Enter');
    await expect(terminal).toContainText('pc-42-in:beta', { timeout: 10_000 });

    // The label now names the shell's Directory (the drawer narrowed the office:
    // the PC is found again).
    const pcBeside = await settledTilePoint(page, PC_TILE.col, PC_TILE.row);
    await page.mouse.move(pcBeside.x, pcBeside.y);
    await expect(page.getByTestId('furniture-label-line')).toHaveText('Shell in Beta');

    // × while a command runs: asked once; Keep Running leaves it.
    await terminal.click();
    await page.keyboard.type('sleep 300');
    await page.keyboard.press('Enter');
    await card.getByTitle('Close shell').click();
    const question = page.getByTestId('pc-shell-close-question');
    await expect(question).toContainText('sleep');
    await page.getByRole('button', { name: 'Keep Running' }).click();
    await expect(question).toHaveCount(0);
    await expect(card).toHaveCount(1);
    expect(await pcState(page)).toBe('on');

    // Deleting the PC in the layout editor is closing its shell: asked the same
    // way while the command runs, and Keep Running keeps the PC too.
    const furniture = () =>
      page.evaluate(
        () => (window as HooksWindow).__pixelAgentsTestHooks?.getFurnitureCount?.() ?? -1,
      );
    const before = await furniture();
    const deletePc = async () => {
      const at = await settledTilePoint(page, PC_TILE.col, PC_TILE.row);
      await page.mouse.click(at.x, at.y);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('Delete');
    };
    await page.getByRole('button', { name: 'Layout', exact: true }).click();
    await deletePc();
    await expect(question).toContainText('Deleting this PC');
    await page.getByRole('button', { name: 'Keep Running' }).click();
    await expect(question).toHaveCount(0);
    await expect(card).toHaveCount(1);
    expect(await furniture()).toBe(before);
    await page.getByRole('button', { name: 'Layout', exact: true }).click();

    // Stop the command; the × on the PC's label (as on an agent's) ends the idle
    // shell at once: card and lit screen go.
    await terminal.click();
    await page.keyboard.press('Control+C');
    const pcAgain = await settledTilePoint(page, PC_TILE.col, PC_TILE.row);
    await page.mouse.move(pcAgain.x, pcAgain.y);
    await page.getByTestId('furniture-label-close').click();
    await expect(card).toHaveCount(0);
    await expect(question).toHaveCount(0);
    await expect.poll(() => pcState(page)).toBeNull();
  });

  test('deleting a PC closes its idle shell with no question @area:standalone', async ({
    page,
    standalone: _standalone,
  }) => {
    const pc = await tilePoint(page, PC_TILE.col, PC_TILE.row);
    await page.mouse.click(pc.x, pc.y);
    const selector = page.getByTestId('pc-directory-selector');
    await selector.getByRole('menuitem', { name: 'Alpha' }).click();
    const card = page.getByTestId('pc-shell-card');
    await expect(card).toHaveCount(1);
    // Two Directories were offered: the card says which.
    await expect(card.getByTestId('pc-shell-card-name')).toHaveText('Alpha');

    // Idle means at its prompt: a shell still starting up counts as running a command.
    await expect(page.locator('.xterm:visible')).toContainText('$', { timeout: 10_000 });

    // Deleting the PC with its shell idle: no question, the shell closes, the PC goes.
    const furniture = () =>
      page.evaluate(
        () => (window as HooksWindow).__pixelAgentsTestHooks?.getFurnitureCount?.() ?? -1,
      );
    const before = await furniture();
    await page.getByRole('button', { name: 'Layout', exact: true }).click();
    const at = await settledTilePoint(page, PC_TILE.col, PC_TILE.row);
    await page.mouse.click(at.x, at.y);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Delete');
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId('pc-shell-close-question')).toHaveCount(0);
    await expect.poll(furniture).toBe(before - 1);
  });

  test.describe('on a phone', () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      standaloneOptions: {
        seedConfig: TWO_DIRECTORIES,
        hostEnv: { SHELL: '/bin/sh' },
        viewport: PHONE,
      },
    });

    test('the first tap shows the label, the second opens the selector, and the shell slides in @area:mobile', async ({
      page,
      standalone: _standalone,
    }) => {
      const pc = await tilePoint(page, PC_TILE.col, PC_TILE.row);

      // First tap: outline + label, nothing opens.
      await page.touchscreen.tap(pc.x, pc.y);
      await expect(label(page)).toHaveAttribute('data-piece-uid', PC_UID);
      await expect(page.getByTestId('pc-directory-selector')).toHaveCount(0);

      // Second tap on the same PC (the first tap centred the camera on it): its click, the selector.
      const pcCentred = await settledTilePoint(page, PC_TILE.col, PC_TILE.row);
      await page.touchscreen.tap(pcCentred.x, pcCentred.y);
      const selector = page.getByTestId('pc-directory-selector');
      await expect(selector).toBeInViewport({ ratio: 1 });
      await selector.getByRole('menuitem', { name: 'Alpha' }).tap();

      // The shell opens on the terminal page, its card in the phone's bar.
      await expect(page.getByTitle('Show office', { exact: true })).toBeVisible();
      await expect(page.getByTestId('pc-shell-card-name')).toHaveText('Alpha');
      const terminal = page.locator('.xterm:visible');
      await expect(terminal).toHaveCount(1);
      await expect.poll(() => pcState(page)).toBe('on');

      // Back on the office (the toggle), the PC is lit and the label went with
      // the tap that opened the shell.
      await page.getByTitle('Show office', { exact: true }).tap();
      await expect.poll(() => pcState(page)).toBe('on');
      await expect(label(page)).toHaveCount(0);
    });
  });
});
