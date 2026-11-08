import { ROLE_VSCODE_UNAVAILABLE_REASON } from '../../server/src/constants.js';
import { roleRejectedMessage } from '../../server/src/roleClientMessages.js';

/**
 * The VS Code panel has no Roles: launchNewTerminal types its command into the
 * user's shell, and it never carries the Role flag. A launchAgent that asks for
 * a Role is therefore refused out loud -- launching it without the Role would
 * silently give the operator a different agent than the one they chose.
 *
 * Returns the reply to post, or null when the message carries no roleId (the
 * launch then proceeds exactly as before).
 */
export function vscodeRoleLaunchRefusal(
  message: Record<string, unknown>,
): Record<string, unknown> | null {
  if (message.type !== 'launchAgent' || message.roleId === undefined) return null;
  return roleRejectedMessage('unavailable', ROLE_VSCODE_UNAVAILABLE_REASON);
}
