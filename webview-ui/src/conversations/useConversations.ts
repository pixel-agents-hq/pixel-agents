import { useEffect, useRef, useState } from 'react';

import type { DirectoryConversations } from '../../../core/src/messages.js';
import {
  CONVERSATIONS_REFRESH_DEBOUNCE_MS,
  CONVERSATIONS_REFRESH_INTERVAL_MS,
} from '../constants.js';
import { transport } from '../transport/index.js';

/** Messages after which the list may have changed: an agent arrived (its
 *  conversation leaves the list), left (it joins), a reconnect resynced, an
 *  agent's turn started or ended (its transcript now exists, or its title
 *  was written — the desktop sidebar stays open, so nothing else would ask),
 *  or a Directory was added, renamed or removed (one section per Directory). */
const REFRESH_ON = new Set([
  'agentCreated',
  'agentClosed',
  'existingAgents',
  'agentStatus',
  'directoriesLoaded',
]);

export interface ConversationList {
  directories: DirectoryConversations[];
  /** When it arrived (ms): the "ago" times are told from it. */
  receivedAt: number;
}

/** Past conversations to list per Directory, where not the default five. */
export type ConversationLimits = Readonly<Record<string, number>>;

/**
 * The sidebar's recent conversations, asked of the server while `open` (the
 * list reads transcripts from disk, so nothing is fetched while it's shut).
 * `limits`: how many past ones a Directory lists ("Show more"); a change asks
 * again at once. Null until the first answer.
 */
export function useConversations(
  open: boolean,
  limits: ConversationLimits = {},
): ConversationList | null {
  const [list, setList] = useState<ConversationList | null>(null);
  const limitsRef = useRef(limits);
  limitsRef.current = limits;
  const limitsKey = JSON.stringify(limits);

  useEffect(() => {
    if (!open) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = () => {
      const entries = Object.entries(limitsRef.current);
      transport.send({
        type: 'requestConversations',
        ...(entries.length > 0
          ? { limits: entries.map(([directoryPath, count]) => ({ directoryPath, count })) }
          : {}),
      });
    };
    const unsubscribe = transport.onMessage((msg) => {
      if (msg.type === 'conversationsLoaded') {
        setList({ directories: msg.directories, receivedAt: Date.now() });
      } else if (REFRESH_ON.has(msg.type)) {
        clearTimeout(timer);
        timer = setTimeout(request, CONVERSATIONS_REFRESH_DEBOUNCE_MS);
      }
    });
    request();
    const every = setInterval(request, CONVERSATIONS_REFRESH_INTERVAL_MS);
    return () => {
      clearTimeout(timer);
      clearInterval(every);
      unsubscribe();
    };
  }, [open, limitsKey]);

  return list;
}

/** Resume a past conversation: the server relaunches it as the character its
 *  agent wore (an agentCreated follows, then its terminal). */
export function resumeConversation(sessionId: string, directoryPath: string): void {
  transport.send({ type: 'resumeConversation', sessionId, directoryPath });
}
