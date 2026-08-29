/**
 * `vscode:uninstall` hook (see package.json scripts) — VS Code executes this
 * with plain Node after the extension has been fully uninstalled. The `vscode`
 * module does not exist here; only Node APIs are available.
 *
 * Removes Pixel Agents hook entries from ~/.claude/settings.json and
 * ~/.cursor/hooks.json so an uninstalled extension leaves no hooks running
 * behind the user's back. The copied hook scripts under ~/.pixel-agents/hooks/
 * are left in place: the standalone CLI shares them and re-adds its own
 * entries on next run.
 */
import { resetHooksConfig } from '../../server/src/configPersistence.js';
import { uninstallHooks } from '../../server/src/providers/hook/claude/claudeHookInstaller.js';
import { uninstallHooks as uninstallCursorHooks } from '../../server/src/providers/hook/cursor/cursorHookInstaller.js';

// There is no UI to surface errors to after uninstall — log and exit cleanly
// (an unhandledRejection here would just be noise in VS Code's uninstall flow).
Promise.all([
  uninstallHooks().catch((err: unknown) => {
    console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
  }),
  uninstallCursorHooks().catch((err: unknown) => {
    console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
  }),
]).finally(() => {
  resetHooksConfig();
});
