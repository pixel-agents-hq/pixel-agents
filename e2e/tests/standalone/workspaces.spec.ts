import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { permissionRequest, preToolUseBash } from '../../helpers/hooks';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  waitForClaudeHookSetup,
} from '../../helpers/mock-claude';
import { expectOverlayCount, expectOverlayVisibleWithTexts } from '../../helpers/office';
import { addDirectory, chooseNoRole, openLaunchDrawer, setSettings } from '../../helpers/webview';
import {
  createWorkspace,
  getAgentCards,
  getNewWorkspaceButton,
  getWorkspaceDirectoryRow,
  getWorkspaceModal,
  getWorkspaceSwitcher,
  getWorkspaceTab,
  selectWorkspaceTab,
  waitForWorkspaceSwitcher,
} from '../../helpers/workspaces';

/**
 * Workspaces in the standalone browser office: tabs that filter the office to
 * one group of Directories' agents, a modal that creates / edits / deletes
 * them, and a server rebroadcast that reaches every open office.
 *
 * Agent-driven cases run the real PTY with the mock claude (e2e/README.md
 * "Mocking model & rules"): the scenario performs every timed action and the
 * test only clicks and observes the browser.
 */

const WORKSPACE_NAME = 'Team B';
const DIRECTORY_NAME = 'Side Project';

/** A real directory under the host's workspace: launching into it is the point. */
function makeDirectory(workspaceDir: string, folder: string): string {
  const target = path.join(workspaceDir, folder);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

test.describe('Standalone / workspaces', () => {
  test('the switcher shows the Default tab selected and a + button @area:standalone', async ({
    page,
    standalone: _standalone,
  }) => {
    await waitForWorkspaceSwitcher(page);
    await expect(getWorkspaceTab(page, 'Default')).toHaveAttribute('aria-selected', 'true');
    await expect(getNewWorkspaceButton(page)).toBeVisible();
    // The default Workspace has neither an edit nor a delete control.
    await expect(getWorkspaceSwitcher(page).getByRole('button', { name: /^Edit / })).toHaveCount(0);
  });

  test('a Directory another Workspace owns is disabled and tagged with that Workspace @area:standalone', async ({
    page,
    standalone,
  }) => {
    await waitForWorkspaceSwitcher(page);
    await addDirectory(page, {
      name: DIRECTORY_NAME,
      path: makeDirectory(standalone.workspaceDir, 'side-project'),
    });
    await createWorkspace(page, WORKSPACE_NAME, [DIRECTORY_NAME]);

    // A second Workspace's modal still lists the Directory, but cannot tick it.
    await getNewWorkspaceButton(page).click();
    const modal = getWorkspaceModal(page);
    await expect(modal).toBeVisible();
    const row = getWorkspaceDirectoryRow(modal, DIRECTORY_NAME);
    await expect(row.getByRole('checkbox')).toBeDisabled();
    await expect(row.getByText(`In ${WORKSPACE_NAME}`, { exact: true })).toBeVisible();
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(modal).toBeHidden();
  });

  test('a Workspace created in one office appears in another open office without a reload @area:standalone', async ({
    page,
    standalone: _standalone,
  }) => {
    await waitForWorkspaceSwitcher(page);
    const other = await page.context().newPage();
    await other.goto(page.url());
    await waitForWorkspaceSwitcher(other);
    await expect(getWorkspaceTab(other, 'Broadcast Team')).toHaveCount(0);

    await createWorkspace(page, 'Broadcast Team');

    await expect(getWorkspaceTab(other, 'Broadcast Team')).toBeVisible({ timeout: 15_000 });
    // The other office stays on its own tab: a broadcast list is not a navigation.
    await expect(getWorkspaceTab(other, 'Default')).toHaveAttribute('aria-selected', 'true');
    await other.close();
  });
});

/** Terminal-driven: the PTY runs the mock claude, the scenario drives the rest. */
test.describe('Standalone / workspaces with agents', () => {
  test.skip(process.platform === 'win32', 'PTY spawn of the .cmd mock shim is untested on Windows');
  test.use({ standaloneOptions: { mockClaude: true } });

  test('an agent launched into a Workspace shows only there, and deleting it returns the agent to Default @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true });
    await waitForClaudeHookSetup(standalone.tmpHome);
    await waitForWorkspaceSwitcher(page);
    await addDirectory(page, {
      name: DIRECTORY_NAME,
      path: makeDirectory(standalone.workspaceDir, 'side-project'),
    });
    await createWorkspace(page, WORKSPACE_NAME, [DIRECTORY_NAME]);

    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('workspace launch')
        .at(1_000)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm test') as Record<string, unknown>)
        .holdOpenFor(90_000)
        .build(),
    );

    // The Directory is launchable from its own Workspace's drawer.
    await selectWorkspaceTab(page, WORKSPACE_NAME);
    const drawer = await openLaunchDrawer(page);
    await drawer.getByRole('button', { name: DIRECTORY_NAME, exact: true }).click();
    await chooseNoRole(page);
    await expectOverlayVisibleWithTexts(page, ['Running: npm test', DIRECTORY_NAME]);
    await expectOverlayCount(page, 1);
    await expect(getAgentCards(page)).toHaveCount(1);

    // Acceptance 4: the other Workspace sees neither the character nor a card.
    await selectWorkspaceTab(page, 'Default');
    await expectOverlayCount(page, 0);
    await expect(getAgentCards(page)).toHaveCount(0);
    await selectWorkspaceTab(page, WORKSPACE_NAME);
    await expectOverlayCount(page, 1);

    // Acceptance 9: deleting the Workspace falls back to Default, where the
    // still-running agent now lives.
    await getWorkspaceSwitcher(page)
      .getByRole('button', { name: `Edit ${WORKSPACE_NAME}`, exact: true })
      .click();
    const modal = getWorkspaceModal(page);
    await modal.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(modal).toBeHidden();
    await expect(getWorkspaceTab(page, WORKSPACE_NAME)).toHaveCount(0);
    await expect(getWorkspaceTab(page, 'Default')).toHaveAttribute('aria-selected', 'true');
    await expectOverlayVisibleWithTexts(page, ['Running: npm test', DIRECTORY_NAME]);
    await expectOverlayCount(page, 1);
    await expect(getAgentCards(page)).toHaveCount(1);
  });

  test('a permission request in another Workspace badges that Workspace tab @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true });
    await waitForClaudeHookSetup(standalone.tmpHome);
    await waitForWorkspaceSwitcher(page);
    await addDirectory(page, {
      name: DIRECTORY_NAME,
      path: makeDirectory(standalone.workspaceDir, 'side-project'),
    });
    await createWorkspace(page, WORKSPACE_NAME, [DIRECTORY_NAME]);

    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('workspace badge')
        .at(1_000)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm test') as Record<string, unknown>)
        .at(2_000)
        .emitHook(permissionRequest('{{sessionId}}') as Record<string, unknown>)
        .holdOpenFor(20_000)
        .build(),
    );

    await selectWorkspaceTab(page, WORKSPACE_NAME);
    const drawer = await openLaunchDrawer(page);
    await drawer.getByRole('button', { name: DIRECTORY_NAME, exact: true }).click();
    await chooseNoRole(page);
    await expectOverlayCount(page, 1);

    // Acceptance 6: the agent is out of sight, so what it waits on is on its tab.
    await selectWorkspaceTab(page, 'Default');
    const badgedTab = getWorkspaceTab(page, `${WORKSPACE_NAME}, 1 need permission`);
    await expect(badgedTab).toBeVisible({ timeout: 15_000 });

    // The agent is still waiting (the mock holds it open), so the active tab
    // hiding its own badge is the rule at work, not the permission ending.
    await selectWorkspaceTab(page, WORKSPACE_NAME);
    await expect(getWorkspaceTab(page, WORKSPACE_NAME)).toHaveAttribute('aria-selected', 'true');
    await expect(getWorkspaceTab(page, `${WORKSPACE_NAME}, 1 need permission`)).toHaveCount(0);

    // Control: leaving again shows the badge is still owed.
    await selectWorkspaceTab(page, 'Default');
    await expect(badgedTab).toBeVisible();
  });
});

const PHONE = { width: 390, height: 844 };
const MIN_TOUCH_TARGET_PX = 44;

test.describe('Standalone / workspaces on a phone', () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    standaloneOptions: { viewport: PHONE },
  });

  test('every switcher control is at least 44px and clears the >_ toggle @area:mobile', async ({
    page,
    standalone: _standalone,
  }) => {
    await waitForWorkspaceSwitcher(page);
    // A second Workspace, selected, so the pencil is on screen as well.
    await getNewWorkspaceButton(page).tap();
    const modal = getWorkspaceModal(page);
    await expect(modal).toBeVisible();
    await modal.getByPlaceholder('Workspace name').fill(WORKSPACE_NAME);
    await modal.getByRole('button', { name: 'Save', exact: true }).tap();
    await expect(modal).toBeHidden();
    await getWorkspaceTab(page, WORKSPACE_NAME).tap();
    await expect(getWorkspaceTab(page, WORKSPACE_NAME)).toHaveAttribute('aria-selected', 'true');

    const toggle = page.getByTitle('Show terminal', { exact: true });
    await expect(toggle).toBeVisible();
    const toggleBox = await toggle.boundingBox();
    expect(toggleBox).not.toBeNull();

    const controls = [
      getWorkspaceTab(page, 'Default'),
      getWorkspaceTab(page, WORKSPACE_NAME),
      getWorkspaceSwitcher(page).getByRole('button', { name: `Edit ${WORKSPACE_NAME}` }),
      getNewWorkspaceButton(page),
    ];
    for (const control of controls) {
      await expect(control).toBeVisible();
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      const overlapsToggle =
        box!.x < toggleBox!.x + toggleBox!.width &&
        box!.x + box!.width > toggleBox!.x &&
        box!.y < toggleBox!.y + toggleBox!.height &&
        box!.y + box!.height > toggleBox!.y;
      expect(overlapsToggle).toBe(false);
    }
  });
});
