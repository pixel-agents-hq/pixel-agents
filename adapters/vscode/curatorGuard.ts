import { curatorRejectedMessage } from '../../server/src/curatorClientMessages.js';

/**
 * The VS Code panel has no curators: its terminals are the editor's, so no
 * agent it launches ever holds a capability (launchNewTerminal never sets one)
 * and nothing could be eligible. A curator request is refused out loud rather
 * than dropped, so the office never waits on an answer that cannot come.
 *
 * Returns the reply to post, or null for any other message.
 */
export function vscodeCuratorRefusal(
  message: Record<string, unknown>,
): Record<string, unknown> | null {
  if (message.type !== 'setWorkspaceCurator' && message.type !== 'unsetWorkspaceCurator') {
    return null;
  }
  return curatorRejectedMessage('unavailable');
}
