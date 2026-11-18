/**
 * Claude Code locks a worktree while a session works in it
 * (`git worktree lock --reason "claude session <name> (pid N …)"`). This
 * reads the process such a lock names; whether it still runs is the
 * caller's check.
 */
export function worktreeLockHolder(lockReason: string): number | null {
  const pid = /\(pid (\d+)/.exec(lockReason)?.[1];
  return pid ? Number(pid) : null;
}
