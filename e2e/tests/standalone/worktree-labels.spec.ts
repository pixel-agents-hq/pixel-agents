import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { sendHookEvent, sessionStartStartup } from '../../helpers/hooks';
import { expectOverlayCount } from '../../helpers/office';
import { createClaudeTranscript } from '../../helpers/team';
import { setSettings } from '../../helpers/webview';

test('a session in a git worktree is labelled with its repository @area:standalone', async ({
  page,
  standalone,
}) => {
  await setSettings(page, { alwaysShowLabels: true, watchAllSessions: true });

  // A repo with a linked worktree, laid out the way `git worktree add` writes it.
  const repo = path.join(standalone.workspaceDir, 'shop-api');
  const worktreeName = 'busy-fox-2bc2ed';
  const gitDir = path.join(repo, '.git', 'worktrees', worktreeName);
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  const worktree = path.join(repo, '.claude', 'worktrees', worktreeName);
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);

  const sessionId = 'standalone-worktree-label';
  const { transcriptPath } = createClaudeTranscript(standalone.tmpHome, worktree, sessionId);
  await sendHookEvent(
    standalone.hookServerConfig,
    sessionStartStartup(sessionId, worktree, transcriptPath),
  );
  await sendHookEvent(standalone.hookServerConfig, {
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    cwd: worktree,
    transcript_path: transcriptPath,
    tool_name: 'Read',
    tool_input: { file_path: path.join(worktree, 'README.md') },
  });

  await expectOverlayCount(page, 1);
  const overlay = page.getByTestId('agent-overlay');
  await expect(overlay).toContainText('shop-api');
  await expect(overlay).not.toContainText('2bc2ed');
});
