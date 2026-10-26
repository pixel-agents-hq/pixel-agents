import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';

// Profile edits reach characters.json only when the view's Save is pressed.
const SAVE_TIMEOUT_MS = 10_000;

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

    await page.getByRole('button', { name: 'Characters', exact: true }).click();
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
    await page.getByRole('button', { name: 'Characters', exact: true }).click();
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

    await page.getByRole('button', { name: 'Characters', exact: true }).click();
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
    await page.getByRole('button', { name: 'Characters', exact: true }).click();
    await view.getByRole('tab', { name: /Hair/ }).click();
    await expect(view.getByRole('button', { name: 'My bob', exact: true })).toBeVisible();
  });
});
