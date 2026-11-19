import fs from 'node:fs';
import path from 'node:path';

import type { Frame, Page } from '@playwright/test';

import { expect, test } from '../../../fixtures/pixel-agents';
import { git, gitHasRef } from '../../../helpers/git';
import { preToolUseBash } from '../../../helpers/hooks';
import {
  arrangeNextClaudeInvocation,
  type ClaudeMockScenario,
  claudeScenario,
  waitForClaudeHookSetup,
} from '../../../helpers/mock-claude';
import { expectOverlayCount, expectOverlayVisibleWithTexts } from '../../../helpers/office';
import {
  confirmNewWorktree,
  getPixelAgentsFrame,
  openLaunchDrawer,
  openPixelAgentsPanel,
} from '../../../helpers/webview';

/**
 * Worktrees in VS Code: the same launch, marker and cleanup as standalone.
 *
 * A multi-root window with folders "alpha" (a plain folder) and "beta" (a git
 * repo, made before VS Code opens). Beta's drawer row offers the worktree
 * button; pressing it runs the agent's terminal in a new Worktree of beta,
 * still an agent of beta, and closing that terminal from VS Code itself
 * applies the leave rules: a clean Worktree goes entirely, one with changes
 * asks in the office.
 *
 * Terminal-driven, so the mock performs the timed actions (e2e/README.md
 * "Mocking model & rules"); the test hovers, clicks and observes.
 */

const ALPHA = 'alpha';
const BETA = 'beta';
const WORKTREE_TIMEOUT_MS = 20_000;

/** Re-open the panel if a terminal took its place + return a fresh frame. */
async function reacquireFrame(window: Page): Promise<Frame> {
  await openPixelAgentsPanel(window);
  return getPixelAgentsFrame(window);
}

/** The one Worktree folder under beta, once the launch has made it. */
async function onlyWorktree(repo: string): Promise<{ name: string; folder: string }> {
  const worktreesDir = path.join(repo, '.claude', 'worktrees');
  await expect
    .poll(() => (fs.existsSync(worktreesDir) ? fs.readdirSync(worktreesDir).length : 0), {
      timeout: WORKTREE_TIMEOUT_MS,
    })
    .toBe(1);
  const [name] = fs.readdirSync(worktreesDir);
  return { name, folder: path.join(worktreesDir, name) };
}

/** Hover beta's row and press its worktree button, with `scenario` queued. */
async function launchIntoBetaWorktree(
  frame: Frame,
  tmpHome: string,
  scenario: ClaudeMockScenario,
): Promise<void> {
  await arrangeNextClaudeInvocation(tmpHome, scenario);
  const drawer = await openLaunchDrawer(frame);
  await drawer.getByRole('button', { name: BETA, exact: true }).hover();
  const worktreeButton = frame.getByRole('button', { name: `New worktree in ${BETA}` });
  await expect(worktreeButton).toBeVisible();
  await worktreeButton.click();
  await confirmNewWorktree(frame);
}

/** Close the agent's terminal the way a user does in VS Code: the × on its editor tab, found by
 *  role and name since its classes vary by VS Code version (`confirmOnKill: never`: no prompt). */
async function killAgentTerminal(window: Page): Promise<void> {
  const terminalTab = window
    .locator('.tabs-container .tab', { hasText: /Claude Code #\d+/ })
    .last();
  await expect(terminalTab).toBeVisible({ timeout: 15_000 });
  await terminalTab.hover();
  await terminalTab.getByRole('button', { name: /^Close/ }).click();
  await expect(terminalTab).toHaveCount(0, { timeout: 15_000 });
}

test.describe('Worktrees (multi-root)', () => {
  test.skip(process.platform === 'win32', 'Worktree launches are untested on Windows');
  test.use({ workspaceFolders: [ALPHA, BETA], gitRepoFolders: [BETA] });

  test('a git workspace folder launches into a Worktree; closing its terminal in VS Code removes it @area:spawn', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, workspaceDir, narrator } = pixelAgents;
    const repo = fs.realpathSync(path.join(workspaceDir, BETA));
    await waitForClaudeHookSetup(tmpHome);

    narrator.step('hovering the rows: only the git folder offers a worktree launch');
    const drawer = await openLaunchDrawer(frame);
    await drawer.getByRole('button', { name: ALPHA, exact: true }).hover();
    await expect(frame.getByRole('button', { name: `New worktree in ${ALPHA}` })).toHaveCount(0);

    await launchIntoBetaWorktree(
      frame,
      tmpHome,
      claudeScenario('vscode worktree launch')
        .at(1_000)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm test') as Record<string, unknown>)
        .holdOpenFor(60_000)
        .build(),
    );

    const { name, folder } = await onlyWorktree(repo);
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(git(folder, 'branch', '--show-current')).toBe(name);
    narrator.check('a Worktree of beta exists, on a branch of its own');

    let office = await reacquireFrame(window);
    // Still beta's agent, on the Worktree's branch: `beta · <icon> <branch>`.
    await expectOverlayVisibleWithTexts(office, ['Running: npm test', BETA], WORKTREE_TIMEOUT_MS);
    await expect(office.locator('[data-testid="agent-overlay-worktree"]')).toBeVisible();
    await expect(office.locator('[data-testid="agent-overlay-origin"]')).toContainText(name);
    await expect(office.locator('[data-testid="card-worktree"]')).toBeVisible();
    narrator.check('the agent is labelled beta, wears the worktree mark and its branch');
    // The main checkout's status stays clean.
    expect(git(repo, 'status', '--porcelain')).toBe('');

    narrator.step("closing the agent's terminal from VS Code");
    await killAgentTerminal(window);

    office = await reacquireFrame(window);
    await expectOverlayCount(office, 0, WORKTREE_TIMEOUT_MS);
    // Nothing in it: the folder and the branch go entirely.
    await expect.poll(() => fs.existsSync(folder), { timeout: WORKTREE_TIMEOUT_MS }).toBe(false);
    // The branch goes right after the folder.
    await expect
      .poll(() => gitHasRef(repo, `refs/heads/${name}`), { timeout: WORKTREE_TIMEOUT_MS })
      .toBe(false);
    narrator.check('the clean Worktree is gone, folder and branch');
  });

  test('a Worktree left with changes asks in the office; Commit to branch keeps them on the branch @area:spawn', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, workspaceDir, narrator } = pixelAgents;
    const repo = fs.realpathSync(path.join(workspaceDir, BETA));
    await waitForClaudeHookSetup(tmpHome);

    // The agent leaves an uncommitted file in its Worktree.
    await launchIntoBetaWorktree(
      frame,
      tmpHome,
      claudeScenario('vscode worktree with changes')
        .at(500)
        .writeJson('{{cwd}}/notes.json', { draft: 'unsaved work' })
        .at(1_000)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm test') as Record<string, unknown>)
        .holdOpenFor(60_000)
        .build(),
    );
    const { name, folder } = await onlyWorktree(repo);
    await expect
      .poll(() => fs.existsSync(path.join(folder, 'notes.json')), {
        timeout: WORKTREE_TIMEOUT_MS,
      })
      .toBe(true);
    let office = await reacquireFrame(window);
    await expectOverlayVisibleWithTexts(office, ['Running: npm test'], WORKTREE_TIMEOUT_MS);
    narrator.check('the Worktree agent is running and has left an uncommitted file');

    narrator.step("closing the agent's terminal from VS Code");
    await killAgentTerminal(window);

    office = await reacquireFrame(window);
    const dialog = office.getByTestId('worktree-decision');
    await expect(dialog).toBeVisible({ timeout: WORKTREE_TIMEOUT_MS });
    await expect(dialog).toContainText(name);
    await expect(dialog).toContainText('uncommitted');
    // Asked, nothing touched yet.
    expect(fs.existsSync(path.join(folder, 'notes.json'))).toBe(true);
    narrator.check('the office asks what to do with the uncommitted changes');

    await office.getByRole('button', { name: 'Commit to branch', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // The folder is gone; the branch holds the save commit with the file.
    await expect.poll(() => fs.existsSync(folder), { timeout: WORKTREE_TIMEOUT_MS }).toBe(false);
    expect(git(repo, 'log', '-1', '--format=%B', name)).toContain('Pixel-Agents-Saved: true');
    expect(JSON.parse(git(repo, 'show', `${name}:notes.json`))).toEqual({ draft: 'unsaved work' });
    expect(git(repo, 'status', '--porcelain')).toBe('');
    narrator.check('Commit to branch: the folder is gone, the changes are saved on the branch');
  });
});
