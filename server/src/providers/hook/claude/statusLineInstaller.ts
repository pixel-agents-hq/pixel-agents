/**
 * Install / uninstall the status line bridge in ~/.claude/settings.json.
 *
 * The bridge is how Pixel Agents learns the account's rate limits: Claude Code
 * hands them (`rate_limits.five_hour` / `seven_day`) only to the status line
 * command, never to hooks. `statusLine` holds one command, so the bridge WRAPS
 * the user's own (statusLineBridge.ts): their status line still renders, byte
 * for byte, and uninstall puts their command back.
 *
 * Same rules as the hook installer, through the one guarded read-modify-write
 * (claudeSettingsFile.ts mutateClaudeSettings: unparseable file refused,
 * one-time backup, re-read before rename): we never rewrite a shape we did
 * not author. A `statusLine` that is not a command setting is refused on
 * install; one whose text after our script was hand-edited is refused on
 * uninstall, since we could no longer tell what to restore. A status line someone replaced after us is theirs —
 * uninstall leaves it alone.
 */

import { isRecord } from '../../../serverConfig.js';
import { bundledScriptPath, copyBundledScript } from './bundledScripts.js';
import { mutateClaudeSettings, readClaudeSettings } from './claudeSettingsFile.js';
import { CLAUDE_STATUSLINE_SCRIPT_NAME } from './constants.js';
import {
  isOurStatusLine,
  isOurStatusLineCommand,
  makeBareStatusLine,
  makeStatusLineCommand,
  type StatusLineSetting,
  wrappedStatusLineCommand,
} from './statusLineBridge.js';

/** Surfaced when `statusLine` exists but is not a `{ type: "command", command }` setting. */
export const STATUSLINE_NOT_COMMAND_MESSAGE =
  'statusLine in ~/.claude/settings.json is not a command status line — fix or remove it';

/** Surfaced when our command was edited by hand after it was written. */
export const STATUSLINE_EDITED_MESSAGE =
  "The Pixel Agents status line in ~/.claude/settings.json was edited by hand, so the original can't be restored — fix or remove it";

/** Whether the user-scope status line runs our bridge. An unreadable or
 *  unparseable file reads as not installed (install then refuses to touch it). */
export function isStatusLineBridgeInstalled(): boolean {
  try {
    return isOurStatusLine(readClaudeSettings().statusLine);
  } catch {
    return false;
  }
}

/**
 * Copy the bridge script from `packageRoot`, then point the status line at it,
 * wrapping the user's command when there is one. Idempotent: an installed
 * bridge is rewritten only if its script path moved. Throws (before any write)
 * on a missing script, an unparseable file, or a status line we may not wrap.
 */
export async function installStatusLineBridge(packageRoot: string): Promise<void> {
  // Script first, like the hooks: a status line pointing at a missing script
  // would blank the user's status bar.
  if (!copyBundledScript(packageRoot, CLAUDE_STATUSLINE_SCRIPT_NAME)) {
    throw new Error('Could not install the status line script — status line left unchanged.');
  }
  const scriptPath = bundledScriptPath(CLAUDE_STATUSLINE_SCRIPT_NAME);
  let wrote: boolean;
  try {
    wrote = await mutateClaudeSettings((settings) => {
      const current = settings.statusLine;
      if (current === undefined) {
        settings.statusLine = makeBareStatusLine(scriptPath);
        return true;
      }
      if (!isCommandSetting(current)) throw new Error(STATUSLINE_NOT_COMMAND_MESSAGE);
      const existing = current.command;
      let wrapped: string | undefined = existing;
      if (isOurStatusLineCommand(existing)) {
        const inner = wrappedStatusLineCommand(existing);
        if (inner === undefined) throw new Error(STATUSLINE_EDITED_MESSAGE);
        wrapped = inner ?? undefined;
      }
      const command = makeStatusLineCommand(scriptPath, wrapped);
      if (command === existing) return false;
      // Only `command` changes: padding, refreshInterval and anything else the
      // user set stay as they were.
      settings.statusLine = { ...current, command };
      return true;
    });
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)} — usage bars not connected.`, {
      cause: e,
    });
  }
  if (wrote) console.log('[Pixel Agents] Status line bridge installed in ~/.claude/settings.json');
}

/**
 * Put the user's status line back: our command wrapping theirs becomes theirs
 * again; our command wrapping nothing is removed. A status line that is not
 * ours is left alone. Throws (before any write) when ours was hand-edited.
 */
export async function uninstallStatusLineBridge(): Promise<void> {
  let wrote: boolean;
  try {
    wrote = await mutateClaudeSettings((settings) => {
      const current = settings.statusLine;
      if (!isOurStatusLine(current)) return false;
      const inner = wrappedStatusLineCommand(current.command);
      if (inner === undefined) throw new Error(STATUSLINE_EDITED_MESSAGE);
      if (inner === null) {
        delete settings.statusLine;
      } else {
        settings.statusLine = { ...current, command: inner };
      }
      return true;
    });
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)} — status line left in place.`, {
      cause: e,
    });
  }
  if (wrote) console.log('[Pixel Agents] Status line restored in ~/.claude/settings.json');
}

/** Refresh the installed bridge script (a new version ships a new script).
 *  No-op when the bridge is not installed. */
export function refreshStatusLineScript(packageRoot: string): void {
  if (isStatusLineBridgeInstalled()) {
    copyBundledScript(packageRoot, CLAUDE_STATUSLINE_SCRIPT_NAME);
  }
}

function isCommandSetting(
  value: unknown,
): value is StatusLineSetting & { type: 'command'; command: string } {
  return (
    isRecord(value) &&
    value.type === 'command' &&
    typeof value.command === 'string' &&
    value.command.trim() !== ''
  );
}
