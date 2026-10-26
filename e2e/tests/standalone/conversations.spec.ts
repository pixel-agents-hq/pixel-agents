import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { arrangeNextClaudeInvocation, claudeScenario } from '../../helpers/mock-claude';
import { expectOverlayCount } from '../../helpers/office';
import { buildTurnDurationRecord } from '../../helpers/team';
import { getLaunchDrawer, setSettings } from '../../helpers/webview';

/**
 * The conversation sidebar: an agent's conversation, once it leaves the
 * office, is listed under its Directory with the title Claude gave it and the
 * character it wore; pressing it resumes that session (`claude --resume`) as
 * the same character, back in the same seat.
 *
 * Terminal-driven: the mock writes the title record and holds the terminal
 * open; the test only clicks and observes (e2e/README.md "Mocking model & rules").
 */
/** The mock's invocation log, empty until its first launch writes it. */
function invocations(logFile: string): string {
  try {
    return fs.readFileSync(logFile, 'utf8');
  } catch {
    return '';
  }
}

/** A session's transcript, wherever the mock filed it ('' until it exists). */
function transcriptText(home: string, sessionId: string): string {
  const projects = path.join(home, '.claude', 'projects');
  try {
    for (const dir of fs.readdirSync(projects)) {
      const file = path.join(projects, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    }
  } catch {
    // No projects dir yet.
  }
  return '';
}

test.describe('Standalone / conversation sidebar', () => {
  test.skip(process.platform === 'win32', 'PTY spawn of the .cmd mock shim is untested on Windows');
  test.use({ standaloneOptions: { mockClaude: true } });

  test('a closed conversation is listed with its title and resumes as the same character in the same seat @area:standalone', async ({
    page,
    standalone,
  }) => {
    // Overlays (what expectOverlayCount counts) show only with labels on.
    await setSettings(page, { alwaysShowLabels: true });
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('titled conversation')
        .at(300)
        .appendJsonl({ type: 'ai-title', aiTitle: 'Refactor the parser' })
        // The turn ends: the sidebar, open all along, asks for the list again.
        .at(600)
        .appendJsonl(buildTurnDurationRecord())
        .holdOpenFor(60_000)
        .build(),
    );

    await page.getByRole('button', { name: 'New agent' }).click();
    await getLaunchDrawer(page)
      .getByRole('button', { name: path.basename(standalone.workspaceDir), exact: true })
      .click();
    await expectOverlayCount(page, 1);

    const before = await page.evaluate(() => {
      const hooks = window.__pixelAgentsTestHooks!;
      const ch = hooks.getCharacters!().find((c) => !c.isGreeter)!;
      const seat = hooks.getAgentSeats!().find((s) => s.id === ch.id)!;
      return { id: ch.id, palette: ch.palette, repeat: ch.repeat, seatId: seat.seatId };
    });
    expect(before.seatId).toBeTruthy();

    // The title has landed (the mock wrote it) before the agent leaves.
    await expect.poll(() => invocations(standalone.mockLogFile)).toContain('session-id=');
    const sessionId = /session-id=(\S+)/.exec(invocations(standalone.mockLogFile))![1];

    const sidebar = page.getByTestId('conversation-sidebar');
    await expect(sidebar).toBeVisible();
    // The mock has written the title.
    await expect
      .poll(() => transcriptText(standalone.tmpHome, sessionId))
      .toContain('Refactor the parser');
    // Running, it is listed with its agent's status dot (titled once the
    // list refreshes; the agent arriving asked for it again).
    const running = sidebar
      .getByTestId('recent-conversations')
      .getByTestId('conversation-row')
      .filter({ has: page.getByTestId('conversation-status') });
    await expect(running).toHaveCount(1);
    // The card's ×: the agent comes in focused, so its overlay has one too.
    await page.getByTitle('Agent 1').locator('button[title="Close agent"]').click();
    await expectOverlayCount(page, 0);

    // Listed at the top among the newest across every Directory…
    const row = sidebar
      .getByTestId('recent-conversations')
      .getByTestId('conversation-row')
      .filter({ hasText: 'Refactor the parser' });
    await expect(row).toBeVisible();
    await expect(running).toHaveCount(0);
    // …and under its Directory, which starts collapsed and expands on a press.
    const titled = sidebar
      .getByTestId('conversation-row')
      .filter({ hasText: 'Refactor the parser' });
    await expect(titled).toHaveCount(1);
    const header = sidebar
      .locator('button[aria-expanded]')
      .filter({ hasText: path.basename(standalone.workspaceDir) });
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await header.click();
    await expect(titled).toHaveCount(2);
    await header.click();
    await expect(titled).toHaveCount(1);

    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('resumed conversation').holdOpenFor(60_000).build(),
    );
    await row.click();
    await expectOverlayCount(page, 1);

    // claude --resume with the same session.
    await expect
      .poll(() => invocations(standalone.mockLogFile))
      .toContain(`args=--resume ${sessionId}`);
    // The same character, back in its seat; and its row is a running one again.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const hooks = window.__pixelAgentsTestHooks!;
          const ch = hooks.getCharacters!().find((c) => !c.isGreeter);
          const seat = ch && hooks.getAgentSeats!().find((s) => s.id === ch.id);
          return ch ? { palette: ch.palette, repeat: ch.repeat, seatId: seat?.seatId } : null;
        }),
      )
      .toEqual({ palette: before.palette, repeat: before.repeat, seatId: before.seatId });
    await expect(running).toHaveCount(1);
  });
});
