import type { Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Drivers for the Intro — the first-run tour the greeter speaks
 * (webview-ui/src/components/IntroBubble.tsx): welcome → get Claude Code
 * (only when the server found no CLI) → choices (a box each for usage bars,
 * live updates and the Pixel Office MCP, where asked; all off to start) → all
 * set (with the tutorial's ask where it can start). Locator-based so the
 * same helpers drive both surfaces: the VS Code webview frame and the
 * standalone browser page.
 *
 * Step content is asserted between clicks rather than clicking "Continue"
 * twice blind: the button keeps its accessible name across steps, so two
 * blind clicks could double-fire on one step and pass over a tour that never
 * advanced.
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
 * Walk the Intro from its opening step to the choices step, past the
 * "First, get Claude Code" step when the server found no CLI (so it may or
 * may not come).
 */
export async function advanceIntroToChoices(dialog: Locator): Promise<void> {
  await expect(dialog).toContainText('Welcome to Pixel Agents!');
  await dialog.getByRole('button', { name: 'Continue' }).click();
  const choices = dialog.getByText('Pick what to turn on');
  const getClaude = dialog.getByText('First, get Claude Code');
  await expect(choices.or(getClaude)).toBeVisible();
  if (await getClaude.isVisible()) {
    await dialog.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(choices).toBeVisible();
}

/**
 * Tick `picks` on the choices step and press Continue (with every box off,
 * past its warning). Waits for the step to settle: the closing step, or the
 * step still up when something it turned on failed.
 */
export async function chooseInIntro(dialog: Locator, picks: IntroPicks = {}): Promise<void> {
  for (const id of ['usage', 'hooks', 'mcp'] as const) {
    if (!picks[id]) continue;
    const box = introChoice(dialog, id);
    await expect(box).toHaveAttribute('aria-pressed', 'false');
    await box.click();
    await expect(box).toHaveAttribute('aria-pressed', 'true');
  }
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  const anyway = dialog.getByRole('button', { name: 'Continue Anyway' });
  const closing = dialog.getByText(/You're all set!|Hooks couldn't be installed/);
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
  const closing = dialog.getByRole('button', { name: "Let's Go" });
  const choices = dialog.getByText('Pick what to turn on');
  await expect(closing.or(choices)).toBeVisible();
  if (await choices.isVisible()) await chooseInIntro(dialog, picks);
  await expect(dialog).toContainText("You're all set!");
  await dialog.getByRole('button', { name: "Let's Go" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}
