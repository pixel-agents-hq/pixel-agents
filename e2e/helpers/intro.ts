import type { Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Drivers for the Intro — the first-run tour the greeter speaks
 * (webview-ui/src/components/IntroDialog.tsx): welcome → get Claude Code
 * (only when the server found no CLI) → choices (a box each for usage bars,
 * live updates and the Pixel Office MCP, where asked; all off to start) → all
 * set (with the tutorial's ask where it can start). Locator-based so the
 * same helpers drive both surfaces: the VS Code webview frame and the
 * standalone browser page.
 *
 * The greeter speaks in a dialog box, one short message at a time; a step's
 * controls are its menu (a stack of options, with any cards or fields over
 * it), shown once its last message is out. `readIntro`
 * presses through the messages to the menu, as a user would.
 */

/** What to tick on the choices step (absent = left off). */
export interface IntroPicks {
  usage?: boolean;
  hooks?: boolean;
  mcp?: boolean;
}

const CHOICE_LABELS = {
  usage: 'Usage bars',
  hooks: 'Live updates',
  mcp: 'Agents that use the office',
};

/** One box of the choices step (only present where the server asks it). */
export function introChoice(dialog: Locator, id: keyof IntroPicks): Locator {
  return dialog.getByRole('button', { name: CHOICE_LABELS[id], exact: true });
}

/**
 * Read the greeter's messages until a step's menu is up: press the dialog's
 * arrow (a first press finishes the typing, the next shows the next message;
 * the welcome's last one goes on to the next step). Does nothing when a menu
 * is already up. Returns everything that was said on the way, the message
 * the menu stands over included.
 */
export async function readIntro(dialog: Locator, timeoutMs = 30_000): Promise<string> {
  const menu = dialog.getByTestId('intro-menu');
  const message = dialog.getByTestId('intro-dialog').locator('p');
  const next = dialog.getByRole('button', { name: 'Next' });
  const said: string[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = (await message.textContent().catch(() => null)) ?? '';
    if (text !== '' && said.at(-1) !== text) said.push(text);
    if (await menu.isVisible()) break;
    if (Date.now() > deadline) {
      await expect(menu, 'the Intro never reached a menu').toBeVisible({ timeout: 1 });
    }
    // The arrow goes as the last message finishes: a press that misses it is retried.
    if (await next.isVisible()) await next.click({ timeout: 1_000 }).catch(() => undefined);
    else await dialog.page().waitForTimeout(50);
  }
  return said.join(' ');
}

/**
 * The closing step, read up to its last menu: past the Discord invite (its
 * Continue) to the tutorial's ask where one is offered, else the invite's own
 * (Let's Go). Returns what was said on the way.
 */
export async function readIntroClosing(dialog: Locator): Promise<string> {
  let said = await readIntro(dialog);
  const next = dialog.getByTestId('intro-invite').getByRole('button', { name: 'Continue' });
  if (await next.isVisible()) {
    await next.click();
    await expect(dialog.getByTestId('tutorial-offer')).toBeVisible();
    said += ' ' + (await readIntro(dialog));
  }
  return said;
}

/**
 * Press the dialog's Back (the message before, then the step before) until
 * `target` shows.
 */
export async function backInIntro(dialog: Locator, target: Locator): Promise<void> {
  const back = dialog.getByRole('button', { name: 'Back', exact: true });
  for (let presses = 0; presses < 12 && !(await target.isVisible()); presses++) {
    await back.click();
  }
  await expect(target).toBeVisible();
}

/**
 * Walk the Intro from its opening step to the choices step's menu, past the
 * get-Claude-Code step when the server found no CLI (so it may or
 * may not come).
 */
export async function advanceIntroToChoices(dialog: Locator): Promise<void> {
  await expect(dialog).toContainText('Welcome to Pixel Agents!');
  await readIntro(dialog);
  const choices = dialog.getByText('Pick what to turn on');
  if (!(await choices.isVisible())) {
    // The install step: its command, then on.
    await expect(dialog.getByText('npm install -g')).toBeVisible();
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(choices).toBeVisible({ timeout: 15_000 });
    await readIntro(dialog);
  }
  await expect(choices).toBeVisible();
}

/**
 * Tick `picks` on the choices step and press Continue (with every box off,
 * past its warning). Waits for the step to settle: the closing step, or the
 * step still up when something it turned on failed.
 */
export async function chooseInIntro(dialog: Locator, picks: IntroPicks = {}): Promise<void> {
  await readIntro(dialog);
  for (const id of ['usage', 'hooks', 'mcp'] as const) {
    if (!picks[id]) continue;
    const box = introChoice(dialog, id);
    await expect(box).toHaveAttribute('aria-pressed', 'false');
    await box.click();
    await expect(box).toHaveAttribute('aria-pressed', 'true');
  }
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  const anyway = dialog.getByRole('button', { name: 'Continue Anyway' });
  const closing = dialog.getByText(/You're all set!|hooks couldn't be installed/);
  await expect(anyway.or(closing)).toBeVisible({ timeout: 15_000 });
  if (await anyway.isVisible()) await anyway.click();
  await expect(closing).toBeVisible({ timeout: 15_000 });
}

/**
 * Close the Intro from its closing step ("You're all set!"). When the tour is
 * still on the choices step (an office asked only the Pixel Office MCP), it
 * is answered with `picks` (default: everything off) on the way.
 */
export async function finishIntro(dialog: Locator, picks: IntroPicks = {}): Promise<void> {
  const closing = dialog.getByText(/You're all set!|hooks couldn't be installed/);
  const choices = dialog.getByText('Pick what to turn on');
  await expect(closing.or(choices)).toBeVisible();
  if (await choices.isVisible()) await chooseInIntro(dialog, picks);
  await expect(dialog).toContainText("You're all set!");
  await readIntroClosing(dialog);
  // Let's Go where no tutorial is offered, else the tutorial ask's No, thanks.
  await dialog.getByRole('button', { name: /^(Let's Go|No, thanks)$/ }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}
