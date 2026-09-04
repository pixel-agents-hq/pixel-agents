import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { preToolUseBash } from '../../helpers/hooks';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  waitForClaudeHookSetup,
} from '../../helpers/mock-claude';
import { expectOverlayCount, expectOverlayVisibleWithTexts } from '../../helpers/office';
import { appendJsonlRecord, createClaudeTranscript } from '../../helpers/team';
import {
  addDirectory,
  getDirectoryModal,
  getDirectorySuggestions,
  getLaunchDrawer,
  getSettingChecked,
  openDirectoryModal,
  openLaunchDrawer,
  setSettings,
  SKIP_PERMISSIONS_LABEL,
  submitDirectoryModal,
} from '../../helpers/webview';

/**
 * The standalone launch surface: the host contributes the directory the server
 * was started from as a read-only Directory, a plain press of the launch button
 * opens the drawer (it never launches by itself), and clicking a row launches
 * an agent into that Directory.
 *
 * Terminal-driven, so it follows the scenario-builder rule (e2e/README.md
 * "Mocking model & rules"): the mock performs all timed actions; the test only
 * hovers, clicks and observes.
 */
test.describe('Standalone / launch drawer', () => {
  // Same POSIX-only constraint as the terminal spec: the PTY spawns the mock's
  // bash wrapper directly, and the .cmd shim needs a cmd.exe hop.
  test.skip(process.platform === 'win32', 'PTY spawn of the .cmd mock shim is untested on Windows');
  test.use({ standaloneOptions: { mockClaude: true } });

  test('the server start directory is a badged host row that launches an agent labeled with it @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true });
    await waitForClaudeHookSetup(standalone.tmpHome);

    // Once launched the mock reports a Bash tool at t+1s and holds open, so the
    // character has a stable activity label to assert alongside its origin.
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('standalone drawer launch')
        .at(1_000)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm test') as Record<string, unknown>)
        .holdOpenFor(60_000)
        .build(),
    );

    // A plain press opens the drawer instead of launching: the first click's
    // only effect is the list.
    await page.getByRole('button', { name: '+ Agent' }).click();
    const drawer = getLaunchDrawer(page);
    await expect(drawer).toBeVisible();

    // The host contributes exactly one Directory: its start cwd, named after
    // the directory itself.
    const directoryName = path.basename(standalone.workspaceDir);
    const row = drawer.getByRole('button', { name: directoryName, exact: true });
    await expect(row).toBeVisible();
    await expect(row.getByText('host', { exact: true })).toBeVisible();
    // Host-contributed rows are not editable in the office: the row is the only
    // control, with no nested edit affordance.
    await expect(row.locator('button')).toHaveCount(0);

    await row.click();

    // The launch really happened in that Directory: its name is the character's
    // origin label, under the activity the mock produced. Exactly one agent —
    // the press that opened the drawer launched nothing.
    await expectOverlayCount(page, 1);
    await expectOverlayVisibleWithTexts(page, ['Running: npm test', directoryName]);
  });
});

/**
 * Directories the user defines in the office: added in the modal, persisted
 * machine-wide in the shared config, and launchable from the drawer.
 */
test.describe('Standalone / user-defined Directories', () => {
  test.skip(process.platform === 'win32', 'PTY spawn of the .cmd mock shim is untested on Windows');
  test.use({ standaloneOptions: { mockClaude: true } });

  test('a Directory added in the modal launches an agent and is still there after a reload @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true });
    await waitForClaudeHookSetup(standalone.tmpHome);

    // A real directory outside the host's own: proving the launch went here
    // rather than into the server's cwd is the whole point.
    const target = path.join(standalone.workspaceDir, 'side-project');
    fs.mkdirSync(target, { recursive: true });

    await addDirectory(page, { name: 'Side Project', path: target });

    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('user directory launch')
        .at(1_000)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm test') as Record<string, unknown>)
        .holdOpenFor(60_000)
        .build(),
    );

    const drawer = await openLaunchDrawer(page);
    const row = drawer.getByRole('button', { name: 'Side Project', exact: true });
    // User-defined: no host badge, and a pencil to re-open the modal on it.
    await expect(row.getByText('host', { exact: true })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Edit Side Project' })).toBeVisible();

    await row.click();

    // The agent really runs in that Directory: the character's origin label is
    // the NAME the Directory was given — "Side Project", not the path's
    // "side-project" — which is also the identity its Area mapping is keyed by.
    await expectOverlayCount(page, 1);
    await expectOverlayVisibleWithTexts(page, ['Running: npm test', 'Side Project']);

    // Machine-wide persistence, not page state: it comes back from the shared
    // config in the isolated HOME.
    const configPath = path.join(standalone.tmpHome, '.pixel-agents', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      directories?: Array<{ name: string; path: string }>;
    };
    expect(cfg.directories).toEqual([{ name: 'Side Project', path: target }]);

    await page.reload();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });
    // Park the pointer away from the launch button first: the drawer opens on
    // hover, and a mouse already sitting on the remounted button might not
    // produce the enter event the drawer waits for.
    await page.mouse.move(0, 0);
    const reloaded = await openLaunchDrawer(page);
    await expect(reloaded.getByRole('button', { name: 'Side Project', exact: true })).toBeVisible();
  });

  test('deleting a Directory drops its row and leaves its running agent alone @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true });
    await waitForClaudeHookSetup(standalone.tmpHome);

    const target = path.join(standalone.workspaceDir, 'doomed-project');
    fs.mkdirSync(target, { recursive: true });
    await addDirectory(page, { name: 'Doomed Project', path: target });

    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('deleted directory launch')
        .at(1_000)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm test') as Record<string, unknown>)
        .holdOpenFor(60_000)
        .build(),
    );

    await (
      await openLaunchDrawer(page)
    )
      .getByRole('button', { name: 'Doomed Project', exact: true })
      .click();
    await expectOverlayVisibleWithTexts(page, ['Running: npm test', 'Doomed Project']);

    // Delete through the pencil's modal.
    await (
      await openLaunchDrawer(page)
    )
      .getByRole('button', { name: 'Edit Doomed Project' })
      .click();
    const modal = getDirectoryModal(page);
    await modal.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(modal).toBeHidden();

    const drawer = await openLaunchDrawer(page);
    await expect(drawer.getByRole('button', { name: 'Doomed Project', exact: true })).toHaveCount(
      0,
    );

    // Cleanup is never destructive: the agent launched from it is still working,
    // still wearing the name the Directory had when it started.
    await expectOverlayCount(page, 1);
    await expectOverlayVisibleWithTexts(page, ['Running: npm test', 'Doomed Project']);
  });
});

/** No terminal involved: validation happens before anything is launched, so
 *  this runs on every platform (unlike the PTY-driven cases above). */
test.describe('Standalone / Directory validation', () => {
  test('an invalid path is refused inline and nothing is persisted @area:standalone', async ({
    page,
    standalone,
  }) => {
    const missing = path.join(standalone.workspaceDir, 'does-not-exist');
    const modal = await openDirectoryModal(page);

    await submitDirectoryModal(modal, { name: 'Ghost', path: missing });

    // The modal stays open with the host's reason on it.
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('alert')).toContainText(missing);

    const configPath = path.join(standalone.tmpHome, '.pixel-agents', 'config.json');
    const cfg = fs.existsSync(configPath)
      ? (JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
          directories?: Array<{ name: string }>;
        })
      : {};
    expect(cfg.directories ?? []).toEqual([]);

    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    const drawer = await openLaunchDrawer(page);
    await expect(drawer.getByRole('button', { name: 'Ghost', exact: true })).toHaveCount(0);
  });
});

/**
 * The modal's tappable path suggestions: directories the coding agent has
 * already been run in, recovered from the session transcripts under the
 * isolated HOME.
 *
 * No terminal is involved — this is the host reading history off disk — so the
 * sessions are seeded as plain transcripts rather than driven through a mock
 * claude scenario (e2e/README.md's scenario rule governs tests that simulate a
 * RUNNING agent; these are finished sessions that predate the office). Nothing
 * mutates a live transcript.
 */
test.describe('Standalone / Directory suggestions', () => {
  /** A finished session that recorded `cwd`, the way a past agent run leaves it. */
  function seedPastSession(tmpHome: string, cwd: string, sessionId: string): void {
    const { transcriptPath } = createClaudeTranscript(tmpHome, cwd, sessionId);
    appendJsonlRecord(transcriptPath, {
      type: 'user',
      cwd,
      message: { role: 'user', content: 'ship it' },
    });
  }

  test('a past session offers its working directory as a tap that fills the path @area:standalone', async ({
    page,
    standalone,
  }) => {
    const worked = path.join(standalone.workspaceDir, 'worked-here');
    fs.mkdirSync(worked, { recursive: true });
    // Deleted since that session ran: a suggestion for it could only ever be
    // refused, so it must not be offered.
    const vanished = path.join(standalone.workspaceDir, 'vanished');

    seedPastSession(standalone.tmpHome, worked, 'worked-session');
    seedPastSession(standalone.tmpHome, vanished, 'vanished-session');
    // The server's own start directory is already a Directory in the drawer, so
    // it must not be offered. Recorded resolved, the way a process reports its
    // own cwd — on macOS the temp dir reaches us through the /var → /private/var
    // symlink, and the host contributes the resolved side of it.
    seedPastSession(standalone.tmpHome, fs.realpathSync(standalone.workspaceDir), 'host-session');

    const modal = await openDirectoryModal(page);
    const suggestions = getDirectorySuggestions(modal);
    const workedSuggestion = suggestions.getByRole('button', { name: worked, exact: true });
    await expect(workedSuggestion).toBeVisible({ timeout: 15_000 });
    await expect(suggestions.getByRole('button', { name: vanished, exact: true })).toHaveCount(0);
    await expect(
      suggestions.getByRole('button', {
        name: fs.realpathSync(standalone.workspaceDir),
        exact: true,
      }),
    ).toHaveCount(0);

    // A tap fills the field and nothing else — the entry still needs a name and
    // a Save, which is what makes suggestions safe to offer on a phone.
    await workedSuggestion.click();
    await expect(modal.getByPlaceholder('~/code/my-project')).toHaveValue(worked);
    await expect(modal).toBeVisible();

    // And the filled path is a usable one: saving it produces the drawer row.
    await submitDirectoryModal(modal, { name: 'Worked Here', path: worked });
    await expect(modal).toBeHidden({ timeout: 15_000 });
    const drawer = await openLaunchDrawer(page);
    await expect(drawer.getByRole('button', { name: 'Worked Here', exact: true })).toBeVisible();

    // Now that it IS a Directory, it stops being a suggestion.
    await drawer.getByRole('button', { name: '+ Directory', exact: true }).click();
    const reopened = getDirectoryModal(page);
    await expect(reopened).toBeVisible();
    await expect(
      getDirectorySuggestions(reopened).getByRole('button', { name: worked, exact: true }),
    ).toHaveCount(0, { timeout: 15_000 });
  });
});

test.describe('Standalone / permission posture', () => {
  test('the skip-permissions setting lands on disk and survives a reload @area:standalone', async ({
    page,
    standalone,
  }) => {
    // Off by default, and nothing in the launch flow offers it any more — the
    // hover gesture belongs to the Directory drawer now.
    expect(await getSettingChecked(page, SKIP_PERMISSIONS_LABEL)).toBe(false);
    await expect(page.getByText('Skip permissions mode')).toHaveCount(0);

    await setSettings(page, { bypassPermissions: true });

    // It is the host's persisted posture, in its own namespace.
    const configPath = path.join(standalone.tmpHome, '.pixel-agents', 'config.json');
    await expect
      .poll(
        () => {
          try {
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
              standalone?: { bypassPermissions?: boolean };
            };
            return cfg.standalone?.bypassPermissions ?? false;
          } catch {
            return false;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    // Reload: the toggle comes back from that persisted config, not from
    // anything the page kept in memory.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });
    expect(await getSettingChecked(page, SKIP_PERMISSIONS_LABEL)).toBe(true);
  });
});
