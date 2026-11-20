import type { Locator } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { chooseInIntro, readIntroClosing } from '../../helpers/intro';
import { arrangeNextClaudeInvocation, claudeScenario } from '../../helpers/mock-claude';

/**
 * The tutorial, from the Intro's offer to the Guide's run and its end: the
 * user allows the Pixel Office MCP, the closing step offers the tutorial, a
 * second step asks before starting a Claude Code session, and on yes the
 * greeter takes a seat and becomes the Guide (Byte): a real agent with a card
 * and a terminal, its first steps in a (collapsed) checklist, in any order.
 *
 * The process boundary holds (e2e/README.md "Mocking model & rules"): the Guide is
 * the mock claude, and its scenario calls the MCP's `tutorial` tool the way
 * Claude Code would, with the token from the `--mcp-config` file the office
 * launched it with. The test only clicks and asserts what the page shows.
 */

/** The Intro, answered up to its closing step with the Pixel Office MCP allowed. */
async function introToClosing(dialog: Locator): Promise<void> {
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await chooseInIntro(dialog, { mcp: true });
  await expect(dialog).toContainText("You're all set!");
}

test.describe('Standalone / Tutorial', () => {
  // The Guide runs in the server's PTY (POSIX only, as terminal.spec.ts).
  test.skip(process.platform === 'win32', 'PTY spawn of the .cmd mock shim is untested on Windows');
  test.use({
    standaloneOptions: {
      mockClaude: true,
      // Hooks answered long ago, the Pixel Office MCP never asked: the Intro
      // is the choices step with that box alone, then the closing step.
      seedConfig: { officeMcpConsent: undefined },
    },
  });

  test('the closing step asks; the greeter sits and becomes the Guide, with a card and a terminal; quests skip in any order, and the finished checklist goes @area:standalone', async ({
    page,
    standalone,
  }) => {
    test.setTimeout(120_000);
    // The Guide, once running: reads the quests, as its skill says to.
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('tutorial guide')
        .at(1_000)
        .callOfficeMcp('tutorial', { action: 'status' }, { saveAs: 'status' })
        .holdOpenFor(90_000)
        .build(),
    );

    const dialog = page.getByRole('dialog');
    await introToClosing(dialog);
    // The closing step asks, and nothing has launched yet.
    const said = await readIntroClosing(dialog);
    expect(said).toContain('Come hang out in our Discord.');
    expect(said).toContain('Want me to show you around?');
    await expect(dialog.getByTestId('tutorial-offer')).toBeVisible();
    await expect(page.getByTitle(/Tutorial/)).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Yes, please!' }).click();

    // The greeter walks to a desk first; then the Guide is an agent with a card
    // and a terminal, and the Intro closes.
    // The dialog goes at once; the greeter walks to its seat on its own.
    await expect(dialog).toBeHidden();
    const card = page.getByTitle(/· Guide$/);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.xterm:visible')).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // The checklist starts collapsed: the tour is the Guide's conversation.
    const panel = page.getByTestId('tutorial-panel');
    await expect(panel).toBeVisible();
    const quest = (id: string) => panel.getByTestId(`tutorial-quest-${id}`);
    await expect(quest('create-character')).toHaveCount(0);
    // The collapsed checklist lines up with the Guide's card: same top, same bottom.
    await expect
      .poll(async () => Math.abs((await panel.boundingBox())!.y - (await card.boundingBox())!.y))
      .toBeLessThan(1);
    const [panelBox, cardBox] = await Promise.all([panel.boundingBox(), card.boundingBox()]);
    expect(Math.abs(panelBox!.y - cardBox!.y)).toBeLessThan(1);
    expect(Math.abs(panelBox!.height - cardBox!.height)).toBeLessThan(1);
    await panel.getByRole('button', { name: 'Show quests' }).click();

    // Four first steps, none ahead of another: any one opens to its goal and Skip.
    const ids = ['create-character', 'add-directory', 'launch-agent', 'edit-layout'];
    for (const id of ids) await expect(quest(id)).toHaveAttribute('data-state', 'open');
    await expect(panel).toContainText('Tutorial 0 / 4');
    const open = async (id: string) => quest(id).getByRole('button', { name: /./ }).first().click();
    await open('edit-layout');
    await expect(quest('edit-layout')).toContainText('Press Layout');
    await quest('edit-layout').getByRole('button', { name: 'Skip' }).click();
    await expect(quest('edit-layout')).toHaveAttribute('data-state', 'skipped');

    // Quit asks once; keeping on keeps the run.
    await panel.getByRole('button', { name: 'Quit Tutorial' }).click();
    await expect(panel).toContainText('close its session');
    await panel.getByRole('button', { name: 'Keep Playing' }).click();

    for (const id of ['add-directory', 'create-character']) {
      await open(id);
      await quest(id).getByRole('button', { name: 'Skip' }).click();
      await expect(quest(id)).toHaveAttribute('data-state', 'skipped');
    }
    await open('launch-agent');
    await quest('launch-agent').getByRole('button', { name: 'Skip' }).click();

    // All closed: it says so, then goes; the Guide stays, and nothing offers to close it.
    await expect(panel).toContainText('Tutorial complete!');
    await expect(panel.getByRole('button', { name: /Close/ })).toHaveCount(0);
    await expect(panel).toBeHidden({ timeout: 15_000 });
    await expect(card).toBeVisible();
  });

  test('No, thanks ends the Intro as before, launching nothing @area:standalone', async ({
    page,
    standalone: _standalone, // boots the office the page opens
  }) => {
    const dialog = page.getByRole('dialog');
    await introToClosing(dialog);
    await readIntroClosing(dialog);
    await expect(dialog.getByTestId('tutorial-offer')).toBeVisible();
    await dialog.getByRole('button', { name: 'No, thanks' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByTestId('tutorial-panel')).toHaveCount(0);
    await expect(page.getByTitle(/Tutorial/)).toHaveCount(0);
  });
});
