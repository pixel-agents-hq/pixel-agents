import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { arrangeNextClaudeInvocation, claudeScenario } from '../../helpers/mock-claude';
import { expectOverlayCount } from '../../helpers/office';
import { buildTurnDurationRecord } from '../../helpers/team';
import {
  directoryPencil,
  getDirectoryModal,
  getLaunchDrawer,
  openDirectoryModal,
  openLaunchDrawer,
  setSettings,
} from '../../helpers/webview';

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

  test('a Directory lists five past conversations, shows five more on request, and the search finds any of them @area:standalone', async ({
    page,
    standalone,
  }) => {
    // Eight past conversations, already on disk where Claude files the
    // workspace's sessions (the CLI files them under the resolved path).
    const projectDir = path.join(
      standalone.tmpHome,
      '.claude',
      'projects',
      fs.realpathSync(standalone.workspaceDir).replace(/[^a-zA-Z0-9-]/g, '-'),
    );
    fs.mkdirSync(projectDir, { recursive: true });
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const base = Date.now() / 1000 - 3600;
    for (let i = 1; i <= 8; i++) {
      const file = path.join(projectDir, `${uuid(i)}.jsonl`);
      fs.writeFileSync(file, JSON.stringify({ type: 'ai-title', aiTitle: `Chat ${i}` }) + '\n');
      fs.utimesSync(file, base + i * 60, base + i * 60);
    }
    await page.reload();

    const sidebar = page.getByTestId('conversation-sidebar');
    const recent = sidebar.getByTestId('recent-conversations').getByTestId('conversation-row');
    await expect(recent).toHaveCount(5);
    await expect(recent.first()).toContainText('Chat 8');

    const header = sidebar
      .locator('button[aria-expanded]')
      .filter({ hasText: path.basename(standalone.workspaceDir) });
    // The header's own section (the header sits directly inside it).
    const section = header.locator('xpath=..');
    const rows = section.getByTestId('conversation-row');
    await header.click();
    await expect(rows).toHaveCount(5);
    await section.getByTestId('conversations-show-more').click();
    await expect(rows).toHaveCount(8);
    await expect(rows.last()).toContainText('Chat 1');
    // Nothing older: no more to show.
    await expect(section.getByTestId('conversations-show-more')).toHaveCount(0);
    // Shut and opened again, it is back to five.
    await header.click();
    await header.click();
    await expect(rows).toHaveCount(5);

    // "See all": every conversation, searched by title.
    await sidebar.getByTestId('conversations-see-all').click();
    const search = page.getByTestId('conversation-search');
    const results = search.getByTestId('conversation-row');
    await expect(results).toHaveCount(8);
    await search.getByTestId('conversation-search-input').fill('chat 3');
    await expect(results).toHaveCount(1);
    await expect(results).toContainText('Chat 3');
    await page.keyboard.press('Escape');
    await expect(search).toBeHidden();

    // A Directory's "See all" searches that Directory; its chip widens it.
    await section.getByTestId('conversations-directory-search').click();
    await expect(search.getByTestId('conversation-search-scope')).toContainText(
      path.basename(standalone.workspaceDir),
    );
    await expect(results).toHaveCount(8);
    await search.getByTestId('conversation-search-scope').click();
    await expect(search.getByTestId('conversation-search-scope')).toHaveCount(0);

    // Pressing a result resumes it.
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('resumed from search').holdOpenFor(60_000).build(),
    );
    await search.getByTestId('conversation-search-input').fill('chat 2');
    await expect(results).toHaveCount(1);
    await results.click();
    await expect(search).toBeHidden();
    await expect
      .poll(() => invocations(standalone.mockLogFile))
      .toContain(`args=--resume ${uuid(2)}`);
  });

  test('a Directory added or deleted gains or loses its section at once, no reload @area:standalone', async ({
    page,
    standalone,
  }) => {
    const target = path.join(standalone.workspaceDir, 'sidebar-section');
    fs.mkdirSync(target, { recursive: true });
    const sidebar = page.getByTestId('conversation-sidebar');
    await expect(sidebar).toBeVisible();
    const section = sidebar.locator('button[aria-expanded]').filter({ hasText: 'Sidebar Section' });
    // Well inside the list's 30 s poll: only the Directory change can explain it.
    const promptly = { timeout: 10_000 };

    const modal = await openDirectoryModal(page);
    await modal.getByPlaceholder('Project name').fill('Sidebar Section');
    await modal.getByPlaceholder('~/code/my-project').fill(target);
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(modal).toBeHidden();
    await expect(section).toHaveCount(1, promptly);

    const drawer = await openLaunchDrawer(page);
    await (await directoryPencil(page, drawer, 'Sidebar Section')).click();
    await getDirectoryModal(page).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(section).toHaveCount(0, promptly);
  });
});
