/**
 * Claude Code's worktree settings, read (never written) for the Worktrees
 * Pixel Agents creates: `worktree.symlinkDirectories` lists folders a new
 * worktree links to the main checkout instead of copying (`node_modules`).
 * The CLI reads it from every settings scope, so we union them: the user's
 * `~/.claude/settings.json` and the project's `.claude/settings.json` and
 * `.claude/settings.local.json`. An unreadable or malformed file contributes
 * nothing.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function symlinkDirectoriesIn(file: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    const worktree = (parsed as { worktree?: unknown } | null)?.worktree;
    const dirs = (worktree as { symlinkDirectories?: unknown } | null | undefined)
      ?.symlinkDirectories;
    return Array.isArray(dirs) ? dirs.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

/** The union of `worktree.symlinkDirectories` over every scope, first seen
 *  first. */
export function symlinkDirectoriesSetting(repoPath: string): string[] {
  const files = [
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(repoPath, '.claude', 'settings.json'),
    path.join(repoPath, '.claude', 'settings.local.json'),
  ];
  const out: string[] = [];
  for (const file of files) {
    for (const dir of symlinkDirectoriesIn(file)) if (!out.includes(dir)) out.push(dir);
  }
  return out;
}
