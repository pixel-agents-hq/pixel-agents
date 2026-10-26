/**
 * `vscode:uninstall` hook (see package.json scripts) — VS Code executes this
 * with plain Node after the extension has been fully uninstalled. The `vscode`
 * module does not exist here; only Node APIs are available.
 *
 * Removes the Pixel Agents hook entries from ~/.claude/settings.json so an
 * uninstalled extension leaves no hooks running behind the user's back. The
 * copied hook script under ~/.pixel-agents/hooks/ is left in place: the
 * standalone CLI shares it and re-adds its own entries on next run.
 *
 * Also puts the user's own status line back if the usage bridge wraps it
 * (Settings → Usage Bars), for the same reason.
 */
import { resetHooksConfig } from '../../server/src/configPersistence.js';
import { uninstallHooks } from '../../server/src/providers/hook/claude/claudeHookInstaller.js';
import { uninstallStatusLineBridge } from '../../server/src/providers/hook/claude/statusLineInstaller.js';

const logError = (err: unknown): void => {
  console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
};

// There is no UI to surface errors to after uninstall — log and exit cleanly
// (an unhandledRejection here would just be noise in VS Code's uninstall flow).
uninstallHooks()
  .catch(logError)
  .then(() => uninstallStatusLineBridge())
  .catch(logError)
  .finally(() => {
    resetHooksConfig();
  });
