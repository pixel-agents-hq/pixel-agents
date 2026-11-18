import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { preToolUseBash } from '../../helpers/hooks';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  waitForClaudeHookSetup,
} from '../../helpers/mock-claude';
import {
  closeAgentFromOverlay,
  expectContextGauge,
  expectOverlayCount,
  expectOverlayVisibleWithTexts,
} from '../../helpers/office';
import { buildAssistantUsageRecord, buildTurnDurationRecord } from '../../helpers/team';
import {
  addDirectory,
  confirmNewWorktree,
  openLaunchDrawer,
  setSettings,
} from '../../helpers/webview';

/** The mock's invocation log, empty until its first launch writes it. */
function invocations(logFile: string): string {
  try {
    return fs.readFileSync(logFile, 'utf8');
  } catch {
    return '';
  }
}

/** git with the test's own identity and none of the GIT_* variables that would
 *  point it at another repo (the suite may run inside a git worktree). */
function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Pixel Agents Test',
      '-c',
      'user.email=test@pixel-agents.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, env, encoding: 'utf-8' },
  ).trim();
}

/** A git repo with one commit under the test's workspace. */
function makeRepo(workspaceDir: string): string {
  const repo = path.join(workspaceDir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '--quiet');
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'initial');
  return repo;
}

/**
 * Launching an agent into a Worktree from the launch drawer: a git repo
 * Directory's row shows the worktree button beside its pencil; pressing it
 * launches an agent into a fresh checkout of the repo on a branch of its own,
 * still an agent of its Directory, wearing the worktree mark on its card and
 * its branch in its label.
 *
 * Terminal-driven, so the mock performs the timed actions (e2e/README.md
 * "Mocking model & rules"); the test only creates the repo, hovers, clicks
 * and observes.
 */
test.describe('Standalone / worktrees', () => {
  test.skip(process.platform === 'win32', 'PTY spawn of the .cmd mock shim is untested on Windows');
  test.use({ standaloneOptions: { mockClaude: true } });

  test('a git Directory row offers a worktree launch; its agent wears the worktree mark @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true });
    await waitForClaudeHookSetup(standalone.tmpHome);

    // A git repo with one commit, and a plain folder beside it.
    const repo = path.join(standalone.workspaceDir, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '--quiet');
    fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', 'initial');
    const plain = path.join(standalone.workspaceDir, 'plain');
    fs.mkdirSync(plain, { recursive: true });

    await addDirectory(page, { name: 'Plain', path: plain });
    await addDirectory(page, { name: 'Repo', path: repo });

    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('worktree launch')
        .at(1_000)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm test') as Record<string, unknown>)
        .holdOpenFor(60_000)
        .build(),
    );

    const drawer = await openLaunchDrawer(page);
    // Not a repo: the pencil only.
    await drawer.getByRole('button', { name: 'Plain', exact: true }).hover();
    await expect(page.getByRole('button', { name: 'Edit Plain' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New worktree in Plain' })).toHaveCount(0);

    // A repo: the worktree button beside the pencil.
    await drawer.getByRole('button', { name: 'Repo', exact: true }).hover();
    const worktreeButton = page.getByRole('button', { name: 'New worktree in Repo' });
    await expect(worktreeButton).toBeVisible();
    await worktreeButton.click();
    await confirmNewWorktree(page);

    // An agent of its Directory, on the Worktree's branch: `Repo · <icon> <branch>`.
    await expectOverlayCount(page, 1);
    await expectOverlayVisibleWithTexts(page, ['Running: npm test', 'Repo']);
    await expect(page.locator('[data-testid="agent-overlay-worktree"]')).toBeVisible();

    const worktreesDir = path.join(repo, '.claude', 'worktrees');
    const [name] = fs.readdirSync(worktreesDir);
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(git(path.join(worktreesDir, name), 'branch', '--show-current')).toBe(name);
    await expect(page.locator('[data-testid="agent-overlay-origin"]')).toContainText(name);

    // The card wears the mark, and its title names the branch.
    const mark = page.locator('[data-testid="card-worktree"]');
    await expect(mark).toBeVisible();
    await expect(page.locator(`[title$=" · worktree ${name}"]`)).toBeVisible();

    // The main checkout's status stays clean.
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
  test('the worktree button asks for a name and a branch to start from @area:standalone', async ({
    page,
    standalone,
  }) => {
    await waitForClaudeHookSetup(standalone.tmpHome);
    const repo = makeRepo(standalone.workspaceDir);
    // A second local branch with work of its own; the checkout stays on main.
    git(repo, 'checkout', '--quiet', '-b', 'other');
    fs.writeFileSync(path.join(repo, 'other.txt'), 'other\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', 'other work');
    git(repo, 'checkout', '--quiet', 'main');
    await addDirectory(page, { name: 'Repo', path: repo });

    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('named worktree')
        .at(1_000)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm test') as Record<string, unknown>)
        .holdOpenFor(60_000)
        .build(),
    );
    const drawer = await openLaunchDrawer(page);
    await drawer.getByRole('button', { name: 'Repo', exact: true }).hover();
    await page.getByRole('button', { name: 'New worktree in Repo' }).click();

    // A generated name to begin with, and the current branch picked.
    const modal = page.locator('[data-testid="new-worktree-modal"]');
    await expect(modal.locator('[data-testid="new-worktree-name"]')).toHaveValue(/^[a-z]+-[a-z]+$/);
    await expect(
      modal.locator('[data-testid="new-worktree-base"][data-branch="local:main"]'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      modal.locator('[data-testid="new-worktree-base"][data-branch="local:other"]'),
    ).toHaveAttribute('aria-checked', 'false');

    // No origin: no local/origin chips.
    await expect(modal.locator('[data-testid="new-worktree-show-origin"]')).toHaveCount(0);

    // A name that is taken as a branch is refused before anything launches.
    await modal.locator('[data-testid="new-worktree-name"]').fill('other');
    await modal.locator('[data-testid="new-worktree-launch"]').click();
    await expect(modal.getByRole('alert')).toContainText('already exists');

    await confirmNewWorktree(page, { name: 'login-fix', from: 'local:other' });
    await expectOverlayVisibleWithTexts(page, ['Running: npm test', 'Repo']);

    const folder = path.join(repo, '.claude', 'worktrees', 'login-fix');
    expect(git(folder, 'branch', '--show-current')).toBe('login-fix');
    expect(fs.existsSync(path.join(folder, 'other.txt'))).toBe(true);
  });

  test('closing a Worktree agent with changes asks before it stops; Commit to branch keeps them on the branch @area:standalone', async ({
    page,
    standalone,
  }) => {
    await waitForClaudeHookSetup(standalone.tmpHome);
    const repo = makeRepo(standalone.workspaceDir);
    await addDirectory(page, { name: 'Repo', path: repo });

    // The agent leaves an uncommitted file in its Worktree.
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('worktree with changes')
        .at(500)
        .writeJson('{{cwd}}/notes.json', { draft: 'unsaved work' })
        .at(1_000)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm test') as Record<string, unknown>)
        .holdOpenFor(60_000)
        .build(),
    );
    const drawer = await openLaunchDrawer(page);
    await drawer.getByRole('button', { name: 'Repo', exact: true }).hover();
    await page.getByRole('button', { name: 'New worktree in Repo' }).click();
    await confirmNewWorktree(page);
    await expectOverlayVisibleWithTexts(page, ['Running: npm test']);

    const worktreesDir = path.join(repo, '.claude', 'worktrees');
    const [name] = fs.readdirSync(worktreesDir);
    const folder = path.join(worktreesDir, name);
    await expect.poll(() => fs.existsSync(path.join(folder, 'notes.json'))).toBe(true);

    // A phone office open on the same server.
    const phoneContext = await page
      .context()
      .browser()!
      .newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
    const phone = await phoneContext.newPage();
    await phone.goto(page.url());

    // The × asks this office, and the agent keeps running meanwhile.
    await closeAgentFromOverlay(page, { text: 'Running: npm test' });
    const question = page.getByTestId('worktree-close-question');
    await expect(question).toBeVisible();
    await expect(question).toContainText(name);
    await expect(page.getByText('uncommitted file')).toBeVisible();
    await expectOverlayVisibleWithTexts(page, ['Running: npm test']);
    await expect(phone.getByTestId('worktree-close-question')).toHaveCount(0);

    // Closing the question leaves the agent running; × asks again.
    await page.keyboard.press('Escape');
    await expect(question).toHaveCount(0);
    await expectOverlayVisibleWithTexts(page, ['Running: npm test']);
    await closeAgentFromOverlay(page, { text: 'Running: npm test' });
    const save = page.getByRole('button', { name: 'Commit to branch', exact: true });
    await expect(save).toBeFocused();
    await save.click();

    // The agent goes, and no office is asked after it has gone.
    await expect(page.getByTestId('worktree-close-question')).toHaveCount(0);
    await expect.poll(() => fs.existsSync(folder)).toBe(false);
    await expect(page.getByTestId('worktree-decision')).toHaveCount(0);
    await expect(phone.getByTestId('worktree-decision')).toHaveCount(0);
    await phoneContext.close();

    // The branch holds the save commit with the file.
    expect(git(repo, 'log', '-1', '--format=%B', name)).toContain('Pixel-Agents-Saved: true');
    expect(JSON.parse(git(repo, 'show', `${name}:notes.json`))).toEqual({ draft: 'unsaved work' });
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  test('a kept Worktree with changes is removed from the list by an answer under its row, no dialog @area:standalone', async ({
    page,
    standalone,
  }) => {
    await waitForClaudeHookSetup(standalone.tmpHome);
    const repo = makeRepo(standalone.workspaceDir);
    await addDirectory(page, { name: 'Repo', path: repo });
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('worktree kept with changes')
        .at(500)
        .writeJson('{{cwd}}/notes.json', { draft: 'unsaved work' })
        .at(1_000)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm test') as Record<string, unknown>)
        .holdOpenFor(60_000)
        .build(),
    );
    const drawer = await openLaunchDrawer(page);
    await drawer.getByRole('button', { name: 'Repo', exact: true }).hover();
    await page.getByRole('button', { name: 'New worktree in Repo' }).click();
    await confirmNewWorktree(page);
    await expectOverlayVisibleWithTexts(page, ['Running: npm test']);
    const worktreesDir = path.join(repo, '.claude', 'worktrees');
    const [name] = fs.readdirSync(worktreesDir);
    const folder = path.join(worktreesDir, name);
    await expect.poll(() => fs.existsSync(path.join(folder, 'notes.json'))).toBe(true);

    // Closed with Leave as is: it stays, kept, its file uncommitted.
    await closeAgentFromOverlay(page, { text: 'Running: npm test' });
    await page.getByRole('button', { name: 'Leave as is', exact: true }).click();
    await expectOverlayCount(page, 0);

    const sidebar = page.getByTestId('conversation-sidebar');
    await sidebar.locator('button[aria-expanded]').filter({ hasText: 'Repo' }).click();
    const listed = sidebar.locator(`[data-testid="worktree-row"][data-worktree="${name}"]`);
    await expect(listed).toHaveAttribute('data-state', 'kept', { timeout: 15_000 });

    // The trash asks under the row; Back changes nothing, and no dialog opens.
    await listed.getByTestId('worktree-remove').click();
    const choices = listed.getByTestId('worktree-files-choice');
    await expect(
      choices.getByRole('button', { name: 'Commit to branch', exact: true }),
    ).toBeVisible();
    await expect(
      choices.getByRole('button', { name: 'Delete changes', exact: true }),
    ).toBeVisible();
    await expect(choices.getByRole('button', { name: 'Leave as is' })).toHaveCount(0);
    await choices.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(choices).toHaveCount(0);
    await listed.getByTestId('worktree-remove').click();
    await choices.getByRole('button', { name: 'Commit to branch', exact: true }).click();

    await expect(listed).toHaveAttribute('data-state', 'parked', { timeout: 15_000 });
    expect(fs.existsSync(folder)).toBe(false);
    expect(JSON.parse(git(repo, 'show', `${name}:notes.json`))).toEqual({ draft: 'unsaved work' });
    await expect(page.getByTestId('worktree-decision')).toHaveCount(0);
  });

  test('a Worktree agent that exits on its own with changes asks every office @area:standalone', async ({
    page,
    standalone,
  }) => {
    await waitForClaudeHookSetup(standalone.tmpHome);
    const repo = makeRepo(standalone.workspaceDir);
    await addDirectory(page, { name: 'Repo', path: repo });

    // The agent leaves an uncommitted file in its Worktree, then exits by itself (/exit).
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('worktree with changes, exits')
        .at(500)
        .writeJson('{{cwd}}/notes.json', { draft: 'unsaved work' })
        .at(1_000)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm test') as Record<string, unknown>)
        .exitAt(6_000)
        .build(),
    );
    const phoneContext = await page
      .context()
      .browser()!
      .newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
    const phone = await phoneContext.newPage();
    await phone.goto(page.url());

    const drawer = await openLaunchDrawer(page);
    await drawer.getByRole('button', { name: 'Repo', exact: true }).hover();
    await page.getByRole('button', { name: 'New worktree in Repo' }).click();
    await confirmNewWorktree(page);
    await expectOverlayVisibleWithTexts(page, ['Running: npm test']);
    const [name] = fs.readdirSync(path.join(repo, '.claude', 'worktrees'));

    // Both offices ask, Commit to branch first in line.
    for (const office of [page, phone]) {
      const dialog = office.getByTestId('worktree-decision');
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      await expect(dialog).toContainText(name);
      await expect(office.getByText('uncommitted file')).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Commit to branch', exact: true })).toBeFocused();

    // Answered once (on the phone): gone in every office.
    await phone.getByRole('button', { name: 'Leave as is', exact: true }).click();
    await expect(page.getByTestId('worktree-decision')).toHaveCount(0);
    await expect(phone.getByTestId('worktree-decision')).toHaveCount(0);
    await phoneContext.close();
  });
  test("a parked Worktree's conversation resumes into its rebuilt folder, the saved changes uncommitted @area:standalone", async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true });
    await waitForClaudeHookSetup(standalone.tmpHome);
    const repo = makeRepo(standalone.workspaceDir);
    await addDirectory(page, { name: 'Repo', path: repo });

    // The agent titles its conversation and leaves an uncommitted file.
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('worktree conversation')
        .at(300)
        .appendJsonl({ type: 'ai-title', aiTitle: 'Draft the notes' })
        .at(500)
        .writeJson('{{cwd}}/notes.json', { draft: 'unsaved work' })
        .at(800)
        .appendJsonl(buildTurnDurationRecord())
        .at(1_000)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm test') as Record<string, unknown>)
        .holdOpenFor(60_000)
        .build(),
    );
    const drawer = await openLaunchDrawer(page);
    await drawer.getByRole('button', { name: 'Repo', exact: true }).hover();
    await page.getByRole('button', { name: 'New worktree in Repo' }).click();
    await confirmNewWorktree(page);
    await expectOverlayVisibleWithTexts(page, ['Running: npm test']);
    await expect.poll(() => invocations(standalone.mockLogFile)).toContain('session-id=');
    const sessionId = /session-id=(\S+)/.exec(invocations(standalone.mockLogFile))![1];

    const worktreesDir = path.join(repo, '.claude', 'worktrees');
    const [name] = fs.readdirSync(worktreesDir);
    const folder = path.join(worktreesDir, name);
    await expect.poll(() => fs.existsSync(path.join(folder, 'notes.json'))).toBe(true);

    // It leaves; Commit to branch parks the branch with the change saved on it.
    await closeAgentFromOverlay(page, { text: 'Running: npm test' });
    await page.getByRole('button', { name: 'Commit to branch', exact: true }).click();
    await expect.poll(() => fs.existsSync(folder)).toBe(false);
    expect(git(repo, 'log', '-1', '--format=%B', name)).toContain('Pixel-Agents-Saved: true');

    // Its conversation is listed with the worktree mark and branch, and the
    // Directory's section lists the parked Worktree.
    const sidebar = page.getByTestId('conversation-sidebar');
    const row = sidebar
      .getByTestId('recent-conversations')
      .getByTestId('conversation-row')
      .filter({ hasText: 'Draft the notes' });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId('conversation-worktree')).toContainText(name);
    await sidebar.locator('button[aria-expanded]').filter({ hasText: 'Repo' }).click();
    const listed = sidebar.locator(`[data-testid="worktree-row"][data-worktree="${name}"]`);
    await expect(listed).toHaveAttribute('data-state', 'parked');
    await expect(listed).toContainText('parked');

    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('resumed worktree').holdOpenFor(60_000).build(),
    );
    // Pressing the Worktree's row resumes its latest conversation.
    await listed.getByTestId('worktree-resume').click();
    await expectOverlayCount(page, 1);
    await expect
      .poll(() => invocations(standalone.mockLogFile))
      .toContain(`args=--resume ${sessionId}`);

    // The folder is back at the same place, on its branch, the saved file
    // uncommitted again; the save commit is gone from the branch.
    expect(fs.existsSync(folder)).toBe(true);
    expect(git(folder, 'branch', '--show-current')).toBe(name);
    expect(JSON.parse(fs.readFileSync(path.join(folder, 'notes.json'), 'utf-8'))).toEqual({
      draft: 'unsaved work',
    });
    expect(git(folder, 'status', '--porcelain')).toBe('?? notes.json');
    expect(git(repo, 'log', '-1', '--format=%B', name)).not.toContain('Pixel-Agents-Saved');
    await expect(page.locator('[data-testid="card-worktree"]')).toBeVisible();
    await expect(listed).toHaveAttribute('data-state', 'active');
    // Running now: the row goes to its agent, and offers nothing to remove.
    await expect(listed.getByTestId('worktree-open')).toBeVisible();
    await expect(listed.getByTestId('worktree-remove')).toHaveCount(0);
  });

  test('an agent that moves itself into a worktree and out again is followed, wearing the mark meanwhile @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true });
    await waitForClaudeHookSetup(standalone.tmpHome);
    const repo = makeRepo(standalone.workspaceDir);
    // The worktree EnterWorktree makes: Claude Code's own, never retired by us.
    const folder = path.join(repo, '.claude', 'worktrees', 'probe');
    git(repo, 'worktree', 'add', '--quiet', '-b', 'worktree-probe', folder);
    await addDirectory(page, { name: 'Repo', path: repo });

    // Hooks name the folder and transcript the session runs in, as the CLI's do.
    const where = { cwd: '{{cwd}}', transcript_path: '{{transcriptPath}}' };
    const bash = (command: string) => ({
      ...(preToolUseBash('{{sessionId}}', command) as Record<string, unknown>),
      ...where,
    });
    const tool = (event: 'PreToolUse' | 'PostToolUse', toolName: string) => ({
      session_id: '{{sessionId}}',
      hook_event_name: event,
      tool_name: toolName,
      tool_input: {},
      ...where,
    });
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('enter and exit a worktree')
        .at(1_000)
        .appendJsonl(buildAssistantUsageRecord(100_000))
        .at(1_200)
        .emitHook(bash('npm test'))
        .at(1_400)
        .emitHook(tool('PostToolUse', 'Bash'))
        // EnterWorktree: the session moves into the worktree, transcript and
        // all; from its PostToolUse on, hooks name the new folder.
        .at(4_000)
        .emitHook(tool('PreToolUse', 'EnterWorktree'))
        .at(4_100)
        .appendJsonl({ type: 'relocated', relocatedCwd: '{{cwd}}/.claude/worktrees/probe' })
        .at(4_200)
        .relocateSession('{{cwd}}/.claude/worktrees/probe')
        .at(4_400)
        .emitHook(tool('PostToolUse', 'EnterWorktree'))
        // The transcript goes on in its new home (its context gauge reads it).
        .at(5_000)
        .appendJsonl(buildAssistantUsageRecord(300_000))
        // ExitWorktree: back in the repo.
        .at(9_000)
        .emitHook(tool('PreToolUse', 'ExitWorktree'))
        .at(9_100)
        .relocateSession('{{cwd}}/../../..')
        .at(9_300)
        .emitHook(tool('PostToolUse', 'ExitWorktree'))
        .at(9_500)
        .emitHook(bash('git status'))
        .holdOpenFor(60_000)
        .build(),
    );
    const drawer = await openLaunchDrawer(page);
    await drawer.getByRole('button', { name: 'Repo', exact: true }).click();

    // An agent of its Directory, in the repo's own checkout.
    await expectOverlayVisibleWithTexts(page, ['Repo']);
    await expectContextGauge(page, 10);
    await expect(page.locator('[data-testid="card-worktree"]')).toHaveCount(0);

    // In the worktree: the same agent, marked, its moved transcript read on.
    await expect(page.locator('[data-testid="card-worktree"]')).toBeVisible({ timeout: 15_000 });
    await expectContextGauge(page, 30);
    await expectOverlayCount(page, 1);
    await expect(page.locator('[data-testid="agent-overlay-origin"]')).toContainText(
      'worktree-probe',
    );

    // Out again: the mark goes, the agent stays.
    await expectOverlayVisibleWithTexts(page, ['Running: git status'], 15_000);
    await expect(page.locator('[data-testid="card-worktree"]')).toHaveCount(0);
    await expectOverlayCount(page, 1);
    await expectContextGauge(page, 30);

    // Claude Code's worktree is left exactly as it was.
    expect(git(folder, 'branch', '--show-current')).toBe('worktree-probe');
  });

  test("one of Claude Code's worktrees is removed from the Worktrees list, folder and branch, after confirming what it loses @area:standalone", async ({
    page,
    standalone,
  }) => {
    const repo = makeRepo(standalone.workspaceDir);
    // A worktree Claude Code left behind (its session stopped from outside),
    // with a file it never committed.
    const folder = path.join(repo, '.claude', 'worktrees', 'probe');
    git(repo, 'worktree', 'add', '--quiet', '-b', 'worktree-probe', folder);
    fs.writeFileSync(path.join(folder, 'draft.txt'), 'never committed\n');
    await addDirectory(page, { name: 'Repo', path: repo });

    const sidebar = page.getByTestId('conversation-sidebar');
    await sidebar.locator('button[aria-expanded]').filter({ hasText: 'Repo' }).click();
    const listed = sidebar.locator('[data-testid="worktree-row"][data-worktree="probe"]');
    await expect(listed).toHaveAttribute('data-owner', 'cli', { timeout: 15_000 });

    // It loses a file: asked first, and Back changes nothing.
    await listed.getByTestId('worktree-remove').click();
    // Read as a screen reader would: the count is drawn in the pixel font.
    await expect(listed).toMatchAriaSnapshot(
      '- paragraph: Remove the folder and branch worktree-probe, losing 1 uncommitted file for good?',
    );
    await listed.getByRole('button', { name: 'Back', exact: true }).click();
    expect(fs.existsSync(path.join(folder, 'draft.txt'))).toBe(true);

    await listed.getByTestId('worktree-remove').click();
    await listed.getByTestId('worktree-confirm-delete').click();
    await expect(listed).toHaveCount(0, { timeout: 15_000 });
    expect(fs.existsSync(folder)).toBe(false);
    expect(git(repo, 'branch', '--list', 'worktree-probe')).toBe('');
  });
});
