/**
 * What a launch asks for beyond where and as whom — the Pixel Office MCP's
 * launch_agent options (the drawer asks none of them) — and the ONE check of
 * them: a launch's own words (Nickname, model, first message) and its
 * permission mode against the provider's modes and the office's posture.
 * Defined once, passed as one object from the tool to the launcher.
 */

import type { HookProvider } from '../../../core/src/provider.js';
import { NICKNAME_MAX_LENGTH } from '../constants.js';

export interface LaunchAsks {
  /** The Nickname it is shown with, after its Directory. */
  nickname?: string;
  /** The session's first message: the CLI's starting prompt, on its command
   *  line (never typed into the terminal, so nothing races the TUI). */
  firstMessage?: string;
  /** The model the CLI runs (its own names and aliases). */
  model?: string;
  /** One of the provider's `permissionModes`. */
  permissionMode?: string;
  /** A seat id: taken when free, else the office picks one. Wins over a
   *  resumed agent's old seat. */
  seatId?: string;
  /** Never skip permission prompts, whatever the office's setting: with no
   *  mode asked the CLI's default mode is used, and its bypass mode is refused
   *  (the tutorial's Guide, whose ask promises the CLI still asks). */
  neverSkipPermissions?: boolean;
}

/** Asks that passed the check: the Nickname trimmed, the permission mode
 *  resolved against the office's posture (`bypassPermissions` is the bypass
 *  mode, `permissionMode` any other). */
export interface CheckedLaunchAsks extends Omit<
  LaunchAsks,
  'permissionMode' | 'neverSkipPermissions'
> {
  bypassPermissions: boolean;
  /** A permission mode of the provider's, the bypass one excepted. */
  permissionMode?: string;
}

/** A model name as a CLI takes it: a word of letters, digits and `._-:/@[]`,
 *  never a flag. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Check a launch's asks. No permission mode asked: the office's posture (skip
 * permissions while its setting is on, `bypassAllowed`). A mode asked: that
 * mode, when the provider has it; its bypass mode only while the office allows
 * it. `neverSkipPermissions` takes the office's allowance away for this launch.
 */
export function checkLaunchAsks(
  provider: Pick<HookProvider, 'displayName' | 'permissionModes' | 'bypassPermissionMode'>,
  bypassAllowed: boolean,
  asks: LaunchAsks = {},
): { ok: true; asks: CheckedLaunchAsks } | { ok: false; reason: string } {
  const problem = wordsProblem(asks);
  if (problem) return { ok: false, reason: problem };
  const { permissionMode: mode, neverSkipPermissions, ...rest } = asks;
  const allowed = bypassAllowed && !neverSkipPermissions;
  const nickname = rest.nickname?.trim();
  const checked = (
    permissions: Pick<CheckedLaunchAsks, 'bypassPermissions' | 'permissionMode'>,
  ) => ({
    ok: true as const,
    asks: { ...rest, nickname, ...permissions },
  });
  if (mode === undefined) return checked({ bypassPermissions: allowed });
  const modes = provider.permissionModes ?? [];
  if (!modes.includes(mode)) {
    return {
      ok: false,
      reason:
        modes.length > 0
          ? `${mode} is not a permission mode of ${provider.displayName}: use one of ${modes.join(', ')}.`
          : `${provider.displayName} takes no permission mode: leave permission_mode out.`,
    };
  }
  if (mode === provider.bypassPermissionMode) {
    return allowed
      ? checked({ bypassPermissions: true })
      : {
          ok: false,
          reason: `${mode} skips every permission prompt, and this office doesn't allow that: the user turns it on in Settings. Launch with another mode.`,
        };
  }
  return checked({ bypassPermissions: false, permissionMode: mode });
}

/** What is wrong with a launch's own words (Nickname, model, first message), or null. */
function wordsProblem(asks: LaunchAsks): string | null {
  if (asks.nickname !== undefined) {
    const nickname = asks.nickname.trim();
    if (!nickname) return 'A nickname needs at least one visible character: leave it out for none.';
    if (nickname.length > NICKNAME_MAX_LENGTH) {
      return `A nickname is at most ${NICKNAME_MAX_LENGTH} characters.`;
    }
    if (CONTROL_CHARS.test(nickname)) return 'A nickname is one line of plain text.';
  }
  if (asks.model !== undefined && !MODEL_NAME.test(asks.model)) {
    return `${asks.model} is not a model name (a model id or alias, like the CLI's --model takes).`;
  }
  if (asks.firstMessage?.includes('\u0000')) {
    return 'The first message cannot hold a NUL character.';
  }
  return null;
}
