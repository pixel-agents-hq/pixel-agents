import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { preToolUseBash, sendHookEvent, sessionStartStartup } from '../../helpers/hooks';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  waitForClaudeHookSetup,
} from '../../helpers/mock-claude';
import { expectOverlayCount, expectOverlayVisible } from '../../helpers/office';
import { clickAddAgent, setSettings } from '../../helpers/webview';

/**
 * The standalone embedded terminal: browser "+ Agent" → server-side PTY running
 * the mock claude → xterm drawer in the page. This is terminal-driven, so it
 * follows the scenario-builder rule (e2e/README.md "Mocking model & rules"):
 * the mock performs all timed actions; the test only clicks and observes.
 */
/** The agent cards' titles, in screen order along the bar's axis. */
async function cardsInOrder(page: Page, axis: 'x' | 'y'): Promise<string[]> {
  const cards = page.locator('[title^="Agent "]');
  const placed = await Promise.all(
    (await cards.all()).map(async (card) => ({
      title: (await card.getAttribute('title')) ?? '',
      box: await card.boundingBox(),
    })),
  );
  return placed
    .filter((c) => c.box)
    .sort((a, b) => a.box![axis] - b.box![axis])
    .map((c) => c.title);
}
const cardsTopToBottom = (page: Page) => cardsInOrder(page, 'y');
const cardsLeftToRight = (page: Page) => cardsInOrder(page, 'x');

test.describe('Standalone / terminal', () => {
  // The PTY spawns `claude` (the mock's bash wrapper) directly, not through a
  // shell. Windows would need a cmd.exe hop to run the .cmd shim — untested
  // on this branch (design doc "Risks"), so the launch path is POSIX-only here.
  // Describe-level: the standalone fixture launches the mock-PATH host BEFORE
  // a test body runs, so an in-body skip would be too late to prevent it.
  test.skip(process.platform === 'win32', 'PTY spawn of the .cmd mock shim is untested on Windows');
  test.use({ standaloneOptions: { mockClaude: true } });

  test('browser-launched agent gets a PTY terminal, hooks route to its character, close cleans up @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true });
    await waitForClaudeHookSetup(standalone.tmpHome);

    // Mock performs its own timeline once launched: a Bash tool start at t+1s
    // (proving hooks from a PTY-launched session route back to this agent's
    // character), then holds the process open while the test observes.
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('standalone pty launch')
        .at(1_000)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm test') as Record<string, unknown>)
        .holdOpenFor(60_000)
        .build(),
    );

    // Launch from the browser: the press opens the Directory drawer, and the
    // click on its single row (the server's start directory) sends launchAgent.
    await clickAddAgent(page);

    // Control plane: terminalSessionOpened -> an agent card (the drawer tab).
    const agentCard = page.getByTitle('Agent 1');
    await expect(agentCard).toBeVisible({ timeout: 15_000 });

    // Data plane, output direction: PTY stdout → WebSocket → xterm DOM. The
    // banner only exists if the mock really ran inside the server's PTY.
    const terminal = page.locator('.xterm').first();
    await expect(terminal).toContainText('mock claude session', { timeout: 15_000 });

    // A character exists for the launched agent, and the t+1s hook lands on it.
    await expectOverlayCount(page, 1);
    await expectOverlayVisible(page, 'Running: npm test');

    // Data plane, input direction: keystrokes → PTY. The kernel's tty echo
    // writes them straight back, so they must appear in the terminal.
    await terminal.click();
    await page.keyboard.type('echo-round-trip');
    await expect(terminal).toContainText('echo-round-trip', { timeout: 10_000 });

    // Reload: the PTY outlives the socket. The reconnected page must rebuild
    // the tab (webviewReady re-announce) and replay scrollback.
    await page.reload();
    await expect(page.getByTitle('Agent 1')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.xterm').first()).toContainText('mock claude session', {
      timeout: 15_000,
    });

    // Close from the card: PTY killed, tab removed, character despawns.
    await page.getByTitle('Agent 1').locator('button[title="Close agent"]').click();
    await expect(page.getByTitle('Agent 1')).toHaveCount(0);
    await expectOverlayCount(page, 0);
  });

  test('every tab takes mouse input, and a narrow window keeps the cards and close reachable @area:standalone', async ({
    page,
    standalone,
  }) => {
    await waitForClaudeHookSetup(standalone.tmpHome);

    for (const n of [1, 2]) {
      await arrangeNextClaudeInvocation(
        standalone.tmpHome,
        claudeScenario(`standalone pty tab ${n}`).holdOpenFor(60_000).build(),
      );
      await clickAddAgent(page);
      await expect(page.getByTitle(`Agent ${n}`)).toBeVisible({ timeout: 15_000 });
    }

    // The FIRST tab: every pane is stacked in the same box, so a later
    // agent's hidden pane must not sit over it. Playwright's click refuses an
    // intercepted target, so the click itself is the assertion.
    await page.getByTitle('Agent 1').click();
    const first = page.locator('.xterm:visible');
    await expect(first).toHaveCount(1);
    await expect(first).toContainText('mock claude session', { timeout: 15_000 });
    await first.click();
    await page.keyboard.type('first-tab-input');
    await expect(first).toContainText('first-tab-input', { timeout: 10_000 });

    // The narrowest window that still gets the desktop drawer (below it the
    // mobile shell takes over): the drawer gives way so the office keeps its
    // card bar, and the panel's hide tab stays on screen.
    await page.setViewportSize({ width: 800, height: 800 });
    await expect(page.getByTitle('Hide terminal')).toBeInViewport({ ratio: 1 });
    await expect(page.getByTitle('Agent 1')).toBeInViewport({ ratio: 1 });
    await expect(page.getByTitle('Agent 2')).toBeInViewport({ ratio: 1 });
  });

  test('a card dragged on the desktop moves on an open phone too, and stays after a reload @area:standalone', async ({
    page,
    standalone,
  }) => {
    await waitForClaudeHookSetup(standalone.tmpHome);
    for (const n of [1, 2]) {
      await arrangeNextClaudeInvocation(
        standalone.tmpHome,
        claudeScenario(`standalone card order ${n}`).holdOpenFor(60_000).build(),
      );
      await clickAddAgent(page);
      await expect(page.getByTitle(`Agent ${n}`)).toBeVisible({ timeout: 15_000 });
    }

    // A phone already showing the office: its bar lists the same cards.
    const phone = await page.context().newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(page.url());
    await expect(phone.getByTitle('Agent 2')).toBeVisible({ timeout: 30_000 });
    expect(await cardsLeftToRight(phone)).toEqual(['Agent 1', 'Agent 2']);

    // Drag Agent 2 above Agent 1 in the desktop column.
    const from = (await page.getByTitle('Agent 2').boundingBox())!;
    const to = (await page.getByTitle('Agent 1').boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + 4, { steps: 8 });
    await page.mouse.up();

    expect(await cardsTopToBottom(page)).toEqual(['Agent 2', 'Agent 1']);
    // No reload: the server tells the open phone.
    await expect
      .poll(() => cardsLeftToRight(phone), { timeout: 10_000 })
      .toEqual(['Agent 2', 'Agent 1']);
    await phone.close();

    await page.reload();
    await expect(page.getByTitle('Agent 2')).toBeVisible({ timeout: 30_000 });
    expect(await cardsTopToBottom(page)).toEqual(['Agent 2', 'Agent 1']);
  });

  test('copies are verbatim; Alt+C copies the selection re-flowed as text @area:standalone', async ({
    page,
    standalone,
  }) => {
    // Windows/Linux key rules on every runner (Ctrl+Shift+C is the keyboard
    // copy there), and the clipboard writes recorded instead of performed.
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Linux x86_64' });
      const written: string[] = [];
      (window as unknown as { __clip: string[] }).__clip = written;
      Object.defineProperty(Navigator.prototype, 'clipboard', {
        get: () => ({
          writeText: (text: string) => {
            written.push(text);
            return Promise.resolve();
          },
        }),
      });
    });
    await page.reload();
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('terminal copy').holdOpenFor(60_000).build(),
    );
    await clickAddAgent(page);
    const terminal = page.locator('.xterm').first();
    await expect(terminal).toContainText('mock claude session', { timeout: 15_000 });
    await terminal.click();

    // A row filled to the soft-wrap width, then a two-space-indented line:
    // exactly what the re-flow heuristic joins, typed through the PTY echo.
    const cols = await page.evaluate(() => {
      const screen = document.querySelector('.xterm-screen');
      const rows = document.querySelector('.xterm-rows');
      const walker = document.createTreeWalker(rows ?? document.body, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      if (!screen || !node) throw new Error('no terminal text');
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 1);
      return Math.round(screen.getBoundingClientRect().width / range.getBoundingClientRect().width);
    });
    const first = 'w'.repeat(cols - 6);
    const second = '  return response.json();';
    await page.keyboard.type(first);
    await page.keyboard.press('Enter');
    await page.keyboard.type(second);
    await expect(terminal).toContainText('response.json();');

    /** Drag-select the first row's first char through the second's last. */
    const selectBoth = async () => {
      const [from, to] = await page.evaluate(
        ({ first, last }) => {
          const rows = document.querySelector('.xterm-rows');
          const rectOf = (needle: string, edge: 'start' | 'end') => {
            const walker = document.createTreeWalker(rows ?? document.body, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
              const i = n.textContent?.indexOf(needle) ?? -1;
              if (i < 0) continue;
              const range = document.createRange();
              const at = edge === 'start' ? i : i + needle.length - 1;
              range.setStart(n, at);
              range.setEnd(n, at + 1);
              const r = range.getBoundingClientRect();
              return { x: edge === 'start' ? r.left + 1 : r.right - 1, y: r.top + r.height / 2 };
            }
            throw new Error(`not on screen: ${needle}`);
          };
          return [rectOf(first, 'start'), rectOf(last, 'end')];
        },
        { first, last: 'response.json();' },
      );
      // Backwards, from the last char: the first row starts at the drawer's
      // resize edge, where a press would grab the handle instead.
      await page.mouse.move(to.x, to.y);
      await page.mouse.down();
      await page.mouse.move(from.x, from.y, { steps: 5 });
      await page.mouse.up();
    };
    const lastWrite = () =>
      page.evaluate(() => (window as unknown as { __clip: string[] }).__clip.at(-1) ?? null);

    // The plain keyboard copy keeps the line break and the indent.
    await selectBoth();
    await page.keyboard.press('Control+Shift+C');
    await expect.poll(lastWrite).toBe(`${first}\n${second}`);

    // Alt+C is the opt-in re-flow: the soft wrap joins.
    await selectBoth();
    await page.keyboard.press('Alt+C');
    await expect.poll(lastWrite).toBe(`${first} ${second.trimStart()}`);
  });

  test('a URL Claude Code broke across rows opens and copies whole @area:standalone', async ({
    page,
    standalone,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Linux x86_64' });
      const written: string[] = [];
      (window as unknown as { __clip: string[] }).__clip = written;
      Object.defineProperty(Navigator.prototype, 'clipboard', {
        get: () => ({
          writeText: (text: string) => {
            written.push(text);
            return Promise.resolve();
          },
        }),
      });
    });
    await page.reload();
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('terminal broken link').holdOpenFor(60_000).build(),
    );
    await clickAddAgent(page);
    const terminal = page.locator('.xterm').first();
    await expect(terminal).toContainText('mock claude session', { timeout: 15_000 });
    await terminal.click();

    // What Claude Code draws for a URL longer than its row: the row filled
    // to the last column, a real newline, the rest after an indent. Typed
    // through the PTY echo at the terminal's width.
    const cols = await page.evaluate(() => {
      const screen = document.querySelector('.xterm-screen');
      const rows = document.querySelector('.xterm-rows');
      const walker = document.createTreeWalker(rows ?? document.body, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      if (!screen || !node) throw new Error('no terminal text');
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 1);
      return Math.round(screen.getBoundingClientRect().width / range.getBoundingClientRect().width);
    });
    const head = 'https://example.com/' + 'a'.repeat(cols - 'https://example.com/'.length);
    const tail = 'tail-of-the-link';
    await page.keyboard.type(head);
    await page.keyboard.press('Enter');
    await page.keyboard.type(`     ${tail}`);
    await expect(terminal).toContainText(tail);

    /** Screen point of `needle`'s first (or last) character. */
    const pointOf = (needle: string, edge: 'start' | 'end') =>
      page.evaluate(
        ({ needle, edge }) => {
          const rows = document.querySelector('.xterm-rows');
          const walker = document.createTreeWalker(rows ?? document.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const i = n.textContent?.indexOf(needle) ?? -1;
            if (i < 0) continue;
            const range = document.createRange();
            const at = edge === 'start' ? i : i + needle.length - 1;
            range.setStart(n, at);
            range.setEnd(n, at + 1);
            const r = range.getBoundingClientRect();
            return { x: edge === 'start' ? r.left + 1 : r.right - 1, y: r.top + r.height / 2 };
          }
          throw new Error(`not on screen: ${needle}`);
        },
        { needle, edge },
      );

    // A click on the first half opens all of it.
    const popups: string[] = [];
    page.on('popup', (p) => popups.push(p.url()));
    const onHead = await pointOf('example.com', 'start');
    await page.mouse.move(onHead.x, onHead.y);
    await page.mouse.click(onHead.x, onHead.y);
    await expect.poll(() => popups.length).toBe(1);
    expect(popups[0]).toBe(head + tail);

    // A plain copy of both rows gives the link back without the break.
    const from = await pointOf('https://', 'start');
    const to = await pointOf(tail, 'end');
    await page.mouse.move(to.x, to.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.press('Control+Shift+C');
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __clip: string[] }).__clip.at(-1) ?? null),
      )
      .toBe(head + tail);
  });
});

test.describe('Standalone / terminal disabled', () => {
  test.use({ standaloneOptions: { cliArgs: ['--no-terminal'] } });

  test('--no-terminal keeps the office watch-only: launch disabled, hook-driven agents still render @area:standalone', async ({
    page,
    standalone,
  }) => {
    // The launch surface is off, with the reason discoverable on the button.
    const addAgent = page.getByRole('button', { name: 'New agent' });
    await expect(addAgent).toBeVisible();
    await expect(addAgent).toBeDisabled();
    await expect(addAgent).toHaveAttribute('title', 'Terminal disabled with --no-terminal.');
    await expect(page.locator('.xterm')).toHaveCount(0);

    // Watching still works: an external session driven over the hook endpoint
    // (the sanctioned standalone exception — no terminal hosts a mock here)
    // renders a character exactly as with the terminal enabled.
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: true });
    const sessionId = 'no-terminal-watch-session';
    await sendHookEvent(
      standalone.hookServerConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir),
    );
    await sendHookEvent(standalone.hookServerConfig, preToolUseBash(sessionId, 'npm test'));

    await expectOverlayCount(page, 1);
    await expectOverlayVisible(page, 'Running: npm test');
  });
});
