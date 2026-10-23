/**
 * `vscode:uninstall` hook (see package.json scripts) — VS Code executes this
 * with plain Node after the extension has been fully uninstalled. The `vscode`
 * module does not exist here; only Node APIs are available.
 *
 * Removes the Pixel Agents hook entries (and the usage meter's status line)
 * from ~/.claude/settings.json so an uninstalled extension leaves no hooks
 * running behind the user's back. The
 * copied hook script under ~/.pixel-agents/hooks/ is left in place: the
 * standalone CLI shares it and re-adds its own entries on next run.
 */
import { resetHooksConfig } from '../../server/src/configPersistence.js';
import {
  uninstallHooks,
  uninstallStatusLine,
} from '../../server/src/providers/hook/claude/claudeHookInstaller.js';

const logError = (err: unknown): void => {
  console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
};

// There is no UI to surface errors to after uninstall — log and exit cleanly
// (an unhandledRejection here would just be noise in VS Code's uninstall flow).
// The usage meter's status line goes too (a user's own is left alone); one
// settings.json write at a time, since each re-reads the file before writing.
uninstallHooks()
  .catch(logError)
  .then(() => uninstallStatusLine())
  .catch(logError)
  .finally(() => {
    resetHooksConfig();
  });
