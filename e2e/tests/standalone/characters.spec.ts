import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { arrangeNextClaudeInvocation, claudeScenario } from '../../helpers/mock-claude';
import { getLaunchDrawer } from '../../helpers/webview';

// Profile edits reach characters.json only when the view's Save is pressed.
const SAVE_TIMEOUT_MS = 10_000;

/** Agents opens the roster; a card's hover pencil opens the editor on it. */
async function editCharacter(page: Page, index: number) {
  await page.getByRole('button', { name: 'Roster', exact: true }).click();
  const card = page.getByTestId('character-picker').getByRole('button', { name: /^Launch as / });
  await card.nth(index).hover();
  await page
    .getByTestId('character-picker')
    .getByRole('button', { name: /^Edit / })
    .nth(index)
    .click();
}

test.describe('Standalone / Characters', () => {
  test('a part picked in the Characters view is saved by Save and survives a reload @area:standalone', async ({
    page,
    standalone,
  }) => {
    const profilesFile = path.join(standalone.tmpHome, '.pixel-agents', 'characters.json');
    const readProfiles = () =>
      fs.existsSync(profilesFile)
        ? (JSON.parse(fs.readFileSync(profilesFile, 'utf-8')) as { name?: string; hat?: string }[])
        : null;

    await editCharacter(page, 0);
    const view = page.locator('.chv-panel');
    await expect(view.getByRole('region', { name: 'Roster' })).toBeVisible();
    // the six default profiles
    await expect(view.locator('.chv-card:not(.chv-card-add)')).toHaveCount(6);

    const save = view.getByRole('button', { name: 'Save', exact: true });
    await expect(view.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
    await view.getByRole('tab', { name: /Hat/ }).click();
    await view.getByRole('button', { name: 'Plain cap' }).click();

    // nothing is written until Save
    await expect(save).toBeEnabled();
    expect(readProfiles()?.[0]?.hat).toBeUndefined();
    await save.click();
    await expect
      .poll(() => readProfiles()?.[0]?.hat, { timeout: SAVE_TIMEOUT_MS })
      .toBe('plain_cap');
    expect(readProfiles()).toHaveLength(6);

    // undo takes it off again, once saved
    await view.getByRole('button', { name: 'Undo' }).click();
    await save.click();
    await expect.poll(() => readProfiles()?.[0]?.hat, { timeout: SAVE_TIMEOUT_MS }).toBeUndefined();
    await view.getByRole('button', { name: 'Redo' }).click();
    await save.click();
    await expect
      .poll(() => readProfiles()?.[0]?.hat, { timeout: SAVE_TIMEOUT_MS })
      .toBe('plain_cap');

    // closing with unsaved changes asks first; Discard drops them
    await view.getByRole('button', { name: 'Badge cap' }).click();
    await view.getByRole('button', { name: 'Close characters' }).click();
    const dialog = page.getByText('Unsaved changes');
    await expect(dialog).toBeVisible();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(page.locator('.chv-root')).toHaveCount(0);
    expect(readProfiles()?.[0]?.hat).toBe('plain_cap');

    // a reload reads the saved cast back
    await page.reload();
    await editCharacter(page, 0);
    await view.getByRole('tab', { name: /Hat/ }).click();
    await expect(view.getByRole('button', { name: 'Plain cap' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

test.describe('Standalone / Characters items', () => {
  test('a piece saved as a new item is worn, saved beside the cast, and offered after a reload @area:standalone', async ({
    page,
    standalone,
  }) => {
    const dir = path.join(standalone.tmpHome, '.pixel-agents');
    const read = <T>(name: string): T | null =>
      fs.existsSync(path.join(dir, name))
        ? (JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as T)
        : null;

    await editCharacter(page, 0);
    const view = page.locator('.chv-panel');
    await view.getByRole('tab', { name: /Hair/ }).click();
    await view.getByRole('button', { name: 'Bob', exact: true }).click();

    // a frame of the export sheet opens the pixel editor; its Item section exports the piece
    const sheet = view.getByLabel(/Sprite sheet that will be exported/);
    await sheet.click({ position: { x: 10, y: 10 } });
    await view
      .getByRole('group', { name: 'Piece to edit' })
      .getByRole('button', { name: 'Hair', exact: true })
      .click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      view.getByRole('button', { name: 'Export PNG' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/-Hair\.png$/);

    await view.getByLabel('New item name').fill('My bob');
    await view.getByRole('button', { name: 'Save as new item' }).click();
    await view.getByRole('button', { name: 'Save', exact: true }).click();

    await expect
      .poll(() => read<{ label: string; base: string }[]>('wardrobe-items.json'), {
        timeout: SAVE_TIMEOUT_MS,
      })
      .toEqual([expect.objectContaining({ label: 'My bob', base: 'bob', piece: 'hair' })]);
    const [item] = read<{ id: string }[]>('wardrobe-items.json')!;
    expect(read<{ hair?: string }[]>('characters.json')?.[0]?.hair).toBe(item.id);

    await page.reload();
    await editCharacter(page, 1);
    await view.getByRole('tab', { name: /Hair/ }).click();
    await expect(view.getByRole('button', { name: 'My bob', exact: true })).toBeVisible();
  });
});

test.describe('Standalone / Characters roster', () => {
  test.skip(process.platform === 'win32', 'PTY spawn of the .cmd mock shim is untested on Windows');
  test.use({ standaloneOptions: { mockClaude: true } });

  test('Agents opens the roster beside the + button: a click launches as that character, the pencil edits it @area:standalone', async ({
    page,
    standalone,
  }) => {
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('desktop roster launch').holdOpenFor(60_000).build(),
    );

    // The toolbar: + (New agent) with the Agents arrow beside it, then
    // Layout; Settings lives at the foot of the conversation sidebar.
    const toolbar = page.getByRole('button', { name: 'New agent' }).locator('xpath=../../..');
    await expect(toolbar.getByRole('button')).toHaveText(['', '', 'Layout']);
    await expect(
      page.getByTestId('conversation-sidebar').getByRole('button', { name: 'Settings' }),
    ).toBeVisible();

    // Roster opens the roster, not the Characters view, starting with + New.
    const characters = page.getByRole('button', { name: 'Roster', exact: true });
    await characters.click();
    const roster = page.getByTestId('character-picker');
    await expect(roster).toBeVisible();
    await expect(page.locator('.chv-root')).toHaveCount(0);
    await expect(roster.getByRole('button', { name: '+ New' })).toBeVisible();

    // A second click closes it; a third reopens it.
    await characters.click();
    await expect(roster).toHaveCount(0);
    await characters.click();

    // A click picks the character and opens the + button's drawer for it…
    const picked = roster.getByRole('button', { name: /^Launch as / }).nth(3);
    const name = ((await picked.getAttribute('aria-label')) ?? '').replace('Launch as ', '');
    await picked.click();
    await expect(roster).toHaveCount(0);
    const drawer = getLaunchDrawer(page);
    await expect(drawer).toContainText(`Launch ${name} in`);

    // …and the agent launched there wears exactly that character.
    await drawer
      .getByRole('button', { name: path.basename(standalone.workspaceDir), exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window.__pixelAgentsTestHooks?.getCharacters?.() ?? [])
            .filter((ch) => ch.id > 0 && !ch.isGreeter)
            .map(({ palette, repeat }) => ({ palette, repeat })),
        ),
      )
      .toEqual([{ palette: 3, repeat: 0 }]);

    // The roster now lists the last-used character first, the rest in cast
    // order: 3, 0, 1, 2, …
    await page.getByRole('button', { name: 'Roster', exact: true }).click();
    await expect(roster.getByRole('button', { name: /^Launch as / }).first()).toHaveAttribute(
      'aria-label',
      `Launch as ${name}`,
    );
    await page.getByRole('button', { name: 'Roster', exact: true }).click();

    // The pencil on a hovered card opens the view on that character (the
    // third card: character 1).
    await editCharacter(page, 2);
    await expect(page.locator('.chv-panel')).toBeVisible();
    await expect(page.getByTestId('character-picker')).toHaveCount(0);
    await expect(page.locator('.chv-card').nth(1)).toHaveAttribute('aria-current', 'true');
  });
});

test.describe('Standalone / Characters roster in a narrow window', () => {
  test.skip(process.platform === 'win32', 'PTY spawn of the .cmd mock shim is untested on Windows');
  test.use({ standaloneOptions: { mockClaude: true, viewport: { width: 390, height: 844 } } });

  test('a narrow desktop window gets the phone strip but keeps its scrollbar @area:standalone', async ({
    page,
    standalone: _launched,
  }) => {
    // Phone layout (the + card), but a mouse: the strip still has a scrollbar.
    await expect(page.getByTitle('Launch agent', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Roster', exact: true }).click();
    const roster = page.getByTestId('character-picker');
    await expect(roster).toHaveAttribute('aria-hidden', 'false');
    await expect(roster.locator('> div')).toHaveCSS('scrollbar-width', 'thin');
  });
});
