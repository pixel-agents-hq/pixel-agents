/**
 * Where Claude Code keeps a repo's worktrees (`claude -w`, EnterWorktree),
 * how it names the session dirs of the folders it runs in, how it locks a
 * worktree a session works in, and which folders its settings link rather
 * than copy (worktreeSettings.ts). Pixel Agents puts its own Worktrees in
 * the same folder, so Claude Code files their sessions with the repo's own.
 */

import { normalizeProjectPath } from '../../../../../core/src/normalizeProjectPath.js';
import type { WorktreeConvention } from '../../../../../core/src/provider.js';
import { symlinkDirectoriesSetting } from './worktreeSettings.js';

/** `<repo>/.claude/worktrees/<name>`. */
const WORKTREES_FOLDER = ['.claude', 'worktrees'] as const;

/** What a worktree's session dir name adds after its repo's:
 *  `--claude-worktrees-`, the worktree's folder name following. */
const WORKTREE_SESSION_DIR_INFIX = normalizeProjectPath(`/${WORKTREES_FOLDER.join('/')}/`);

export const claudeWorktreeConvention: WorktreeConvention = {
  folder: WORKTREES_FOLDER,
  // The session dir is named after the folder's path, every character that
  // isn't a letter, digit or `-` replaced by `-`.
  sessionDirName: normalizeProjectPath,
  worktreeOfSessionDir(dirName, repoDirName) {
    const prefix = `${repoDirName}${WORKTREE_SESSION_DIR_INFIX}`;
    return repoDirName.length > 0 && dirName.length > prefix.length && dirName.startsWith(prefix)
      ? dirName.slice(prefix.length)
      : null;
  },
  // A session works in a worktree under `git worktree lock --reason "claude
  // session <name> (pid N …)"`: the process it names.
  lockHolder(lockReason) {
    const pid = /\(pid (\d+)/.exec(lockReason)?.[1];
    return pid ? Number(pid) : null;
  },
  symlinkDirectories: symlinkDirectoriesSetting,
};
