import type { ConfigNamespace } from './configPersistence.js';
import { readConfig, writeConfig } from './configPersistence.js';
import {
  getClaudeConfigDir,
  setClaudeConfigDirOverride,
} from './providers/hook/claude/claudeConfigDir.js';
import { uninstallHooksAt } from './providers/hook/claude/claudeHookInstaller.js';

/**
 * 1: set the live override from the persisted setting (synchronous --
 * anything that reaches getClaudeConfigDir() after this point, even
 * moments later, must see it). 2: if THIS SURFACE's hooks might still be
 * sitting in a DIFFERENT directory than the one that's now resolved, remove
 * them from there -- cheap no-op if there's nothing to clean up.
 *
 * Call once, as early as possible in boot, before any code path can reach
 * installHooks(). `namespace` scopes the installed-at record to this
 * surface only (vscode vs standalone) so VS Code and standalone can never
 * uninstall hooks the other surface is relying on -- each only ever
 * compares against, and cleans up, its own record.
 *
 * Step 2 is fired without being awaited: this function itself stays
 * synchronous, which the VS Code adapter's call site (inside a constructor)
 * needs -- a constructor cannot await. That's safe here because step 2 is a
 * best-effort cleanup of an ABANDONED directory, not a precondition
 * installHooks() depends on; the ordering guarantee this function's callers
 * actually need is step 1's synchronous override, not step 2's completion.
 * Worst case if installHooks() on the NEW directory races ahead of this
 * finishing is both directories briefly firing hooks, not data loss -- the
 * uninstall itself still goes through the same guarded mutate/backup cycle
 * as every other settings.json write, so it can never lose the old
 * directory's user content even running concurrently with something else
 * touching that file.
 */
export function prepareClaudeConfigDirForBoot(namespace: ConfigNamespace): void {
  const cfg = readConfig();
  setClaudeConfigDirOverride(cfg.claudeConfigDir || undefined);
  const resolvedDir = getClaudeConfigDir();
  const installedAt = cfg[namespace].claudeConfigDirHooksInstalledAt;
  if (installedAt && installedAt !== resolvedDir) {
    uninstallHooksAt(installedAt).catch((e: unknown) => {
      console.error(`[Pixel Agents] Failed to clean up stale hooks at ${installedAt}: ${e}`);
    });
  }
}

/**
 * 3: record where THIS SURFACE's hooks now live, once installHooks() has
 * actually succeeded. Call from EVERY installHooks() call site on this
 * surface (both the boot-time install and the settings-modal hooks-enabled
 * toggle), not just boot -- missing either one reopens the orphaned-hooks
 * bug this module exists to fix.
 */
export function recordClaudeConfigDirHooksInstalled(namespace: ConfigNamespace): void {
  const cfg = readConfig(); // re-read rather than reuse prepareClaudeConfigDirForBoot()'s cfg
  cfg[namespace].claudeConfigDirHooksInstalledAt = getClaudeConfigDir();
  writeConfig(cfg);
}
