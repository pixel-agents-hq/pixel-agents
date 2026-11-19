import { expect, test } from '../../fixtures/standalone';
import { advanceIntroToChoices, readIntro } from '../../helpers/intro';

/**
 * The Intro's sign-in step (webview-ui/src/components/IntroSignIn.tsx): a
 * Claude Code with no login holds the tour before the choices until the user
 * signs it in from the office. The mock CLI speaks `claude auth status` /
 * `claude auth login` as the real one does and starts out signed out here
 * (PIXEL_AGENTS_MOCK_SIGNED_OUT); its sign-in page "ends on" the code
 * `mock-code`.
 */
test.describe('Standalone / sign-in', () => {
  test.use({
    seedHooksConsent: false,
    standaloneOptions: { mockClaude: true, hostEnv: { PIXEL_AGENTS_MOCK_SIGNED_OUT: '1' } },
  });

  test('a signed-out Claude Code holds the Intro until a code signs it in @area:standalone', async ({
    page,
    standalone: _standalone,
  }) => {
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText('Welcome to Pixel Agents!');

    // The sign-in step, not the choices.
    expect(await readIntro(dialog)).toContain("isn't signed in to Claude Code");
    await expect(dialog.getByTestId('intro-sign-in')).toBeVisible();
    await expect(dialog.getByText('Pick what to turn on')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Continue' })).toHaveCount(0);

    // One button starts it; the page it names is linked beside the code field.
    await dialog.getByRole('button', { name: 'Sign In' }).click();
    const link = dialog.getByRole('link', { name: 'Open Sign-In Page' });
    await expect(link).toHaveAttribute('href', 'https://claude.example/mock-sign-in');

    // A code the CLI refuses says why and leaves the step where it was.
    await dialog.getByLabel('Sign-in code').fill('not-the-code');
    await dialog.getByRole('button', { name: 'Finish' }).click();
    await expect(dialog.getByTestId('intro-sign-in-error')).toContainText(
      "That code wasn't accepted.",
    );
    await expect(dialog).toContainText("isn't signed in to Claude Code");

    // The right one signs it in: the greeter says so, and reading on reaches the choices.
    await readIntro(dialog);
    await dialog.getByRole('button', { name: 'Sign In' }).click();
    await dialog.getByLabel('Sign-in code').fill('mock-code');
    await dialog.getByRole('button', { name: 'Finish' }).click();
    await expect(dialog).toContainText('Claude Code is signed in. On we go!');
    await readIntro(dialog);
    await expect(dialog.getByText('Pick what to turn on')).toBeVisible({ timeout: 15_000 });
  });

  test('a reload after signing in skips the step @area:standalone', async ({
    page,
    standalone: _standalone,
  }) => {
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await readIntro(dialog);
    await dialog.getByRole('button', { name: 'Sign In' }).click();
    await dialog.getByLabel('Sign-in code').fill('mock-code');
    await dialog.getByRole('button', { name: 'Finish' }).click();
    await expect(dialog).toContainText('Claude Code is signed in. On we go!');
    await readIntro(dialog);
    await expect(dialog.getByText('Pick what to turn on')).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await advanceIntroToChoices(dialog);
    await expect(dialog.getByText("isn't signed in to Claude Code")).toHaveCount(0);
  });
});
