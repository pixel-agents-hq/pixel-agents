/**
 * The working directory a session transcript records.
 *
 * Claude Code stamps a `cwd` string on its transcript records. It is the only
 * faithful source of a session's directory when no hook delivered one: the
 * encoded project dir (`-tmp-hobbyfi-blog-automation`) has replaced every
 * separator with a dash, so it can't tell `hobbyfi-blog-automation` from
 * `.../blog/automation`.
 */

import * as fs from 'fs';
import * as path from 'path';

/** How much of a transcript's head is searched for a cwd. Every user/assistant
 *  record carries one, so it turns up within the first few records; the cap
 *  keeps a long-running session's transcript from being read whole. */
export const TRANSCRIPT_CWD_HEAD_BYTES = 64 * 1024;

/**
 * The first non-empty string `cwd` among the transcript's leading records, or
 * undefined (missing/unreadable file, no record within the head carries one).
 * Malformed lines are skipped — the transcript is appended to live, so a
 * partial write is normal — and a head that filled the buffer drops its last,
 * cut-off line instead of parsing it.
 */
export function cwdFromTranscript(jsonlFile: string): string | undefined {
  let text: string;
  let truncated: boolean;
  try {
    const fd = fs.openSync(jsonlFile, 'r');
    try {
      const buf = Buffer.alloc(TRANSCRIPT_CWD_HEAD_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, TRANSCRIPT_CWD_HEAD_BYTES, 0);
      text = buf.toString('utf-8', 0, bytesRead);
      truncated = bytesRead === TRANSCRIPT_CWD_HEAD_BYTES;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }

  const lines = text.split('\n');
  if (truncated) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { cwd?: unknown } | null;
      if (rec && typeof rec.cwd === 'string' && rec.cwd.length > 0) return rec.cwd;
    } catch {
      /* partial or malformed line: keep looking */
    }
  }
  return undefined;
}

/**
 * The repo a working directory belongs to, by name: the directory's basename,
 * except inside a git worktree kept in the repo itself --
 * `<repo>/.claude/worktrees/<name>` (Claude Code's agent worktrees) or
 * `<repo>/.worktrees/<name>`, at any depth below -- which counts as `<repo>`.
 * Without this, every helper agent's labels, tasks and tokens land on its own
 * "repo" named after the worktree (`agent-a02c…`, `phase-g`).
 */
export function repoNameForCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  for (let i = parts.length - 2; i >= 1; i--) {
    if (parts[i] === 'worktrees' && parts[i - 1] === '.claude' && i >= 2) return parts[i - 2];
    if (parts[i] === '.worktrees') return parts[i - 1];
  }
  return parts[parts.length - 1] ?? '';
}

/** Directories already named by repoNameForCwdOnDisk. */
const checkoutNames = new Map<string, string>();
/** Past this many, the cache starts over (a long-running board sees new dirs). */
const CHECKOUT_NAMES_MAX = 5_000;

/**
 * repoNameForCwd, plus: a directory inside a git checkout counts as the
 * checkout -- the nearest folder up from it holding `.git` -- so a session
 * that ran in `hobbyfi-video-automation/assets` is `hobbyfi-video-automation`,
 * not `assets`. A cwd outside any checkout (or gone from disk) keeps its
 * basename. Cached per cwd: the walk touches the disk.
 */
export function repoNameForCwdOnDisk(cwd: string): string {
  const cached = checkoutNames.get(cwd);
  if (cached !== undefined) return cached;
  const folded = repoNameForCwd(cwd);
  let name = folded;
  // A worktree pattern already named the repo; otherwise look for the checkout.
  if (folded === path.basename(cwd)) {
    for (let dir = cwd; ;) {
      if (fs.existsSync(path.join(dir, '.git'))) {
        name = repoNameForCwd(dir);
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  if (checkoutNames.size >= CHECKOUT_NAMES_MAX) checkoutNames.clear();
  checkoutNames.set(cwd, name);
  return name;
}
