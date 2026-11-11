import type { Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Drivers for the Intro — the four-step first-run tour the greeter speaks
 * (webview-ui/src/components/IntroBubble.tsx). Locator-based so the same
 * helpers drive both surfaces: the VS Code webview frame and the standalone
 * browser page.
 *
 * Step content is asserted between clicks rather than clicking "Continue"
 * twice blind: the button keeps its accessible name across steps, so two
 * blind clicks could double-fire on one step and pass over a tour that never
 * advanced.
 */

/**
 * Walk the Intro from its opening step to the consent step, skipping the
 * "Track your usage" step when the tour offers it (only when the usage bridge
 * can be installed and isn't yet, so it may or may not come).
 */
export async function advanceIntroToConsentStep(dialog: Locator): Promise<void> {
  await expect(dialog).toContainText('Welcome to Pixel Agents!');
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog).toContainText('Claude Code');
  await dialog.getByRole('button', { name: 'Continue' }).click();
  const install = dialog.getByRole('button', { name: 'Install Hooks' });
  const skipUsage = dialog.getByRole('button', { name: 'Skip', exact: true });
  await expect(install.or(skipUsage)).toBeVisible();
  if (await skipUsage.isVisible()) {
    await expect(dialog).toContainText('Track your usage');
    await skipUsage.click();
  }
  await expect(install).toBeVisible();
}

/** Close the Intro from its closing step ("You're all set!"). */
export async function finishIntro(dialog: Locator): Promise<void> {
  await expect(dialog).toContainText("You're all set!");
  await dialog.getByRole('button', { name: "Let's Go" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}
