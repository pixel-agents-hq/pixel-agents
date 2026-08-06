import type { ConfigNamespace } from './configPersistence.js';
import { readConfig, writeConfig } from './configPersistence.js';
import {
  getClaudeConfigDir,
  setClaudeConfigDirOverride,
} from './providers/hook/claude/claudeConfigDir.js';
import { uninstallHooksAt } from './providers/hook/claude/claudeHookInstaller.js';

/**
 * 1: set the live override from the persisted setting. 2: if THIS SURFACE's
 * hooks might still be sitting in a DIFFERENT directory than the one that's
 * now resolved, remove them from there -- cheap no-op if there's nothing to
 * clean up.
 *
 * Call once, as early as possible in boot, before any code path can reach
 * installHooks(). `namespace` scopes the installed-at record to this
 * surface only (vscode vs standalone) so VS Code and standalone can never
 * uninstall hooks the other surface is relying on -- each only ever
 * compares against, and cleans up, its own record.
 */
export function prepareClaudeConfigDirForBoot(namespace: ConfigNamespace): void {
  const cfg = readConfig();
  setClaudeConfigDirOverride(cfg.claudeConfigDir || undefined);
  const resolvedDir = getClaudeConfigDir();
  const installedAt = cfg[namespace].claudeConfigDirHooksInstalledAt;
  if (installedAt && installedAt !== resolvedDir) {
    uninstallHooksAt(installedAt);
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
