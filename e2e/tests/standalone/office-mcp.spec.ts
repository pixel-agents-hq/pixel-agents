import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { finishIntro } from '../../helpers/intro';
import { buildSeedLayout } from '../../helpers/layout-seed';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  waitForClaudeHookSetup,
} from '../../helpers/mock-claude';
import { clickAddAgent } from '../../helpers/webview';

/**
 * The Pixel Office MCP's whole loop in a browser: the user allows it in the
 * Intro, an agent launched from the office launches another with a first
 * message and messages it, and the office shows the sender walking over with
 * the gist in its speech bubble.
 *
 * The process boundary holds (e2e/README.md "Mocking model & rules"): the
 * agent's side of the wire is the mock claude's. Its scenario calls the MCP
 * tools the way Claude Code's HTTP MCP client would — with the endpoint and
 * per-agent token from the `--mcp-config` file the office launched it with
 * (`callOfficeMcp`), which nothing else in the test reads. The test only
 * clicks and asserts what the page shows.
 */

/** Two seats nine tiles apart on an open floor, so a Message is a real walk. */
function twoSeatOffice(): Record<string, unknown> {
  const layout = buildSeedLayout({ cols: 14, rows: 8 });
  layout.furniture = [
    { uid: 'seat-west', type: 'WOODEN_CHAIR_SIDE', col: 2, row: 4 },
    { uid: 'seat-east', type: 'WOODEN_CHAIR_SIDE:left', col: 11, row: 4 },
  ];
  return layout;
}

interface CharacterTile {
  id: number;
  col: number;
  row: number;
}

async function characterTiles(page: Page): Promise<CharacterTile[]> {
  return await page.evaluate(() => {
    interface Hooks {
      getCharacters?: () => Array<{ id: number; col: number; row: number; isGreeter?: boolean }>;
    }
    const hooks = (window as { __pixelAgentsTestHooks?: Hooks }).__pixelAgentsTestHooks;
    return (hooks?.getCharacters?.() ?? [])
      .filter((ch) => !ch.isGreeter && ch.id > 0)
      .map(({ id, col, row }) => ({ id, col, row }));
  });
}

test.describe('Standalone / Pixel Office MCP', () => {
  // The agents run in the server's PTYs (POSIX only, as terminal.spec.ts).
  test.skip(process.platform === 'win32', 'PTY spawn of the .cmd mock shim is untested on Windows');
  test.use({
    standaloneOptions: {
      mockClaude: true,
      // Hooks answered long ago, the Pixel Office MCP never asked: the
      // Intro shows its step alone.
      seedConfig: { officeMcpConsent: undefined },
      seedLayout: twoSeatOffice(),
      // The mock reads its terminal like Claude Code's TUI and shows what is typed.
      hostEnv: { PIXEL_AGENTS_MOCK_STDIN: 'record' },
    },
  });

  test('an agent launches another with a first message and messages it; the office shows the walk and the gist @area:standalone', async ({
    page,
    standalone,
  }) => {
    test.setTimeout(120_000);
    const firstMessage = 'Review the README for typos';
    const text = 'The tests pass, ship it';
    const gist = 'Tests pass, ship it';

    // Consent in the Intro: without it no launch gets the MCP.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText('Agents that use the office');
    await finishIntro(dialog, { mcp: true });
    await waitForClaudeHookSetup(standalone.tmpHome);

    // The first agent: once running, it launches a helper with a first
    // message, reads the helper's screen, and messages it with that token.
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('office mcp sender')
        .at(1_000)
        .callOfficeMcp(
          'launch_agent',
          {
            directory: standalone.workspaceDir,
            first_message: firstMessage,
            nickname: 'reviewer',
          },
          { saveAs: 'launched' },
        )
        // The helper's screen settles (banner, prompt) before it is read.
        .at(1_000)
        .callOfficeMcp(
          'read_agent_terminal',
          { agent_id: '{{mcp.launched.agent_id}}' },
          { saveAs: 'screen', waitMs: 2_000 },
        )
        .at(1_000)
        .callOfficeMcp(
          'send_message',
          {
            to: ['{{mcp.launched.agent_id}}'],
            text,
            gist,
            screen_tokens: { '{{mcp.launched.agent_id}}': '{{mcp.screen.screen_token}}' },
          },
          { saveAs: 'sent', waitMs: 3_000 },
        )
        .holdOpenFor(90_000)
        .build(),
    );
    // The helper it launches: it only shows its prompt and what is typed.
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('office mcp helper').holdOpenFor(90_000).build(),
    );

    await clickAddAgent(page);
    await expect(page.getByTitle('Agent 1', { exact: true })).toBeVisible({ timeout: 15_000 });

    // The helper joins the office: its card carries the nickname, and its
    // terminal shows the first message it was started with.
    const helperCard = page.getByTitle('Agent 2 · reviewer', { exact: true });
    await expect(helperCard).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await characterTiles(page)).length, { timeout: 15_000 }).toBe(2);
    await helperCard.click();
    const helperTerminal = page.locator('.xterm:visible');
    await expect(helperTerminal).toContainText(`> ${firstMessage}`, { timeout: 15_000 });

    // The Message show: the sender's character walks over to the helper's
    // and says the gist beside it.
    const gistBubble = page.locator('[data-testid="agent-gist"][data-agent-id="1"]');
    await expect(gistBubble).toBeVisible({ timeout: 30_000 });
    await expect(gistBubble).toContainText(gist);
    // Beside it while it speaks (polled: the helper is idle, so it may still
    // be taking a step when the sender arrives; the stop re-aims after it).
    await expect
      .poll(
        async () => {
          if (!(await gistBubble.isVisible())) return 'gist gone';
          const tiles = await characterTiles(page);
          const sender = tiles.find((ch) => ch.id === 1);
          const helper = tiles.find((ch) => ch.id === 2);
          if (!sender || !helper) return 'a character is missing';
          return Math.abs(sender.col - helper.col) + Math.abs(sender.row - helper.row);
        },
        { message: 'the sender stands beside the helper while it says the gist', timeout: 4_000 },
      )
      .toBe(1);

    // And the text reached the helper's terminal, tagged with who sent it.
    await expect(helperTerminal).toContainText(`agent 1] ${text}`, { timeout: 15_000 });
  });
});
