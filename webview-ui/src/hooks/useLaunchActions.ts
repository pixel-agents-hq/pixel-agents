import { useCallback } from 'react';

import { resumeConversation } from '../conversations/useConversations.js';
import { transport } from '../transport/index.js';
import type { Directory } from './useExtensionMessages.js';

/**
 * Launching an agent and resuming a conversation, from either shell. Both
 * tell the terminal drawer first (`expectLaunch`), so the agent's terminal
 * opens focused once the server announces it.
 */
export function useLaunchActions(expectLaunch: () => void) {
  // palette: the character picked from the roster (absent = the Directory's
  // default characters, else a random pick, server-side).
  const launch = useCallback(
    (directory: Directory, palette?: number) => {
      expectLaunch();
      transport.send({ type: 'launchAgent', directoryPath: directory.path, palette });
    },
    [expectLaunch],
  );
  const resume = useCallback(
    (sessionId: string, directoryPath: string) => {
      expectLaunch();
      resumeConversation(sessionId, directoryPath);
    },
    [expectLaunch],
  );
  return { launch, resume };
}
