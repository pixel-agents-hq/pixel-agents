import { expect, test } from '../../fixtures/standalone';
import { preToolUseBash, sendHookEvent, sessionStartStartup } from '../../helpers/hooks';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  waitForClaudeHookSetup,
} from '../../helpers/mock-claude';
import { expectOverlayCount, expectOverlayVisible } from '../../helpers/office';
import { setSettings } from '../../helpers/webview';

/**
 * The standalone embedded terminal: browser "+ Agent" → server-side PTY running
 * the mock claude → xterm drawer in the page. This is terminal-driven, so it
 * follows the scenario-builder rule (e2e/README.md "Mocking model & rules"):
 * the mock performs all timed actions; the test only clicks and observes.
 */
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

    // Launch from the browser. Single workspace folder, so the click sends
    // launchAgent directly.
    await page.getByRole('button', { name: '+ Agent' }).click();

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
      await page.getByRole('button', { name: '+ Agent' }).click();
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
    // card bar, and the panel's own close button stays on screen.
    await page.setViewportSize({ width: 800, height: 800 });
    await expect(page.getByTitle('Close terminal')).toBeInViewport({ ratio: 1 });
    await expect(page.getByTitle('Agent 1')).toBeInViewport({ ratio: 1 });
    await expect(page.getByTitle('Agent 2')).toBeInViewport({ ratio: 1 });
  });
});

test.describe('Standalone / terminal disabled', () => {
  test.use({ standaloneOptions: { cliArgs: ['--no-terminal'] } });

  test('--no-terminal keeps the office watch-only: launch disabled, hook-driven agents still render @area:standalone', async ({
    page,
    standalone,
  }) => {
    // The launch surface is off, with the reason discoverable on the button.
    const addAgent = page.getByRole('button', { name: '+ Agent' });
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
