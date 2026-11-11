import { expect, test } from '../../fixtures/standalone';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  waitForClaudeHookSetup,
} from '../../helpers/mock-claude';
import { clickAddAgent } from '../../helpers/webview';

/**
 * The Pixel Office MCP's Character tools in a browser: an agent launched from
 * the office creates a character with edit_characters, the open office's
 * roster lists it, and the Characters view's "Undo <agent>'s edit" takes it
 * out again.
 *
 * The process boundary holds (e2e/README.md "Mocking model & rules"): the
 * agent's side of the wire is the mock claude's, calling the MCP tool with the
 * endpoint and token from the `--mcp-config` the office launched it with
 * (`callOfficeMcp`, as office-mcp.spec.ts). The test only clicks and asserts
 * what the page shows.
 */

test.describe('Standalone / Pixel Office MCP characters', () => {
  // The agent runs in the server's PTY (POSIX only, as terminal.spec.ts).
  test.skip(process.platform === 'win32', 'PTY spawn of the .cmd mock shim is untested on Windows');
  test.use({
    standaloneOptions: {
      mockClaude: true,
      // The Pixel Office MCP allowed up front: every launch gets it.
      seedConfig: { officeMcpConsent: 'granted' },
    },
  });

  test("an agent's create_character joins the open office's roster and the Characters view's undo reverts it @area:standalone", async ({
    page,
    standalone,
  }) => {
    test.setTimeout(90_000);
    await waitForClaudeHookSetup(standalone.tmpHome);

    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('office mcp character creator')
        .at(1_000)
        .callOfficeMcp(
          'edit_characters',
          {
            ops: [
              {
                op: 'create_character',
                name: 'Naruto',
                parts: { hair: 'spiky', top: 'tshirt' },
                colors: { hair: { name: 'Yellow' }, top: { name: 'Orange' } },
              },
            ],
          },
          { saveAs: 'edit' },
        )
        .holdOpenFor(60_000)
        .build(),
    );

    await clickAddAgent(page);
    await expect(page.getByTitle('Agent 1', { exact: true })).toBeVisible({ timeout: 15_000 });

    // The roster carousel lists the agent's character, with no reload.
    const picker = page.getByTestId('character-picker');
    const naruto = picker.getByRole('button', { name: 'Launch as Naruto', exact: true });
    await page.getByRole('button', { name: 'Roster', exact: true }).click();
    await expect(naruto).toBeVisible({ timeout: 20_000 });

    // The Characters view (opened on another character) offers to undo the agent's edit.
    const firstCard = picker.getByRole('button', { name: /^Launch as / }).first();
    await firstCard.hover();
    await picker
      .getByRole('button', { name: /^Edit / })
      .first()
      .click();
    const view = page.locator('.chv-panel');
    const viewRoster = view.getByRole('region', { name: 'Roster' });
    await expect(
      viewRoster.getByRole('button', { name: 'Edit Naruto', exact: true }),
    ).toBeVisible();
    const undo = view.getByRole('button', { name: /^Undo .+'s edit$/ });
    await expect(undo).toBeVisible({ timeout: 10_000 });

    await undo.click();
    await expect(viewRoster.getByRole('button', { name: 'Edit Naruto', exact: true })).toHaveCount(
      0,
      { timeout: 10_000 },
    );
    // Nothing left to undo: the button goes with it.
    await expect(undo).toHaveCount(0);

    // And the office's roster no longer lists it.
    await view.getByRole('button', { name: 'Close characters' }).click();
    await expect(page.locator('.chv-root')).toHaveCount(0);
    // (Editing from the carousel closed it.)
    await page.getByRole('button', { name: 'Roster', exact: true }).click();
    await expect(picker.getByRole('button', { name: /^Launch as / }).first()).toBeVisible();
    await expect(naruto).toHaveCount(0);
  });
});
