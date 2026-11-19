# EnterWorktree, recorded live (Claude Code 2.1.310, Haiku, 2026-10-26)

One throwaway repo, project-level hooks logging every payload, user settings off (`--setting-sources project`).
Paths are sanitized: `/REPO_PARENT/repo` is the repo, `-REPO_PARENT-repo` its project-dir hash, `/HOME`, `/TMP`.
Attachment / api-request / snapshot records are stripped from the transcripts.

- `print-mode.*` — `claude -p`: EnterWorktree probe → Write → Bash pwd → ExitWorktree (keep) → Bash pwd.
- `interactive.*` — interactive TTY: EnterWorktree probe2 → Write → Bash pwd, then the session was killed while still in the worktree.

## Findings

1. **Hook payloads follow the move at once.** From EnterWorktree's PostToolUse on, `cwd` is the worktree and
   `transcript_path` is `<repo hash>--claude-worktrees-<name>/<session>.jsonl`. After ExitWorktree's PostToolUse they
   point back at the repo. `session_id` never changes.
2. **Where the transcript lives differs by mode.**
   - Interactive: the whole file (from its first record) is MOVED into `<repo hash>--claude-worktrees-<name>/`,
     same file name; the old path no longer exists. The hook's `transcript_path` is right.
   - Print mode (`-p`): the file STAYS in the repo's project dir and keeps growing there; the worktree's project dir
     is created but stays empty. The hook's `transcript_path` names a file that does not exist.

   So: never trust `transcript_path` blindly. Re-point only when that file exists; otherwise keep watching the
   current file (same session id, same bytes — keep the read offset either way, the content is the same file).

3. **The transcript says so itself.** EnterWorktree writes `{"type":"relocated","relocatedCwd":<worktree>}` and
   `{"type":"worktree-state","worktreeSession":{…}}` with `originalCwd`, `worktreePath`, `worktreeName`,
   `worktreeBranch`, `originalBranch`, `originalHeadCommit`, `sessionId` (each twice). ExitWorktree writes `relocated` back to the repo and
   `worktreeSession: null`. Records after the move carry the new `cwd`. Without hooks, these records are the signal:
   after a `relocated`, if the watched file vanishes, look for `<new project dir>/<session id>.jsonl`.
4. EnterWorktree's own worktree is Claude's (`worktree-<name>` branch, not in our registry) → shown, never managed.

Used by `server/__tests__/agentMoves.test.ts`, which points the placeholders at a temporary repo and the isolated `$HOME`.
