/**
 * The inbox's live client state: inboxState.ts's reducer behind a tiny
 * external store, so the inbox panel, the agent labels and the TODAY strip
 * read one copy without threading props through App.
 */

import { useEffect, useSyncExternalStore } from 'react';

import type { ServerMessage } from '../../../core/src/messages.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { transport } from '../transport/index.js';
import type { InboxState } from './inboxState.js';
import { EMPTY_INBOX, reduceInbox } from './inboxState.js';

// ── The store ────────────────────────────────────────────────

let current: InboxState = EMPTY_INBOX;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): InboxState {
  return current;
}

/** Apply a message to the shared store; true when the state changed. */
export function dispatchInboxMessage(msg: ServerMessage, now = Date.now()): boolean {
  const next = reduceInbox(current, msg, now);
  if (next === current) return false;
  current = next;
  for (const listener of listeners) listener();
  return true;
}

/** The inbox state, re-rendering on change. */
export function useInboxState(): InboxState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Feed the store from the transport, and tell the office who is paused (the
 * living office keeps them at their desks rather than on the smoking terrace).
 * Mounted once, beside useExtensionMessages.
 */
export function useInboxMessages(getOfficeState: () => OfficeState): void {
  useEffect(() => {
    return transport.onMessage((msg) => {
      dispatchInboxMessage(msg);
      if (msg.type === 'agentLimit') getOfficeState().setAgentPaused(msg.id, msg.paused);
      else if (msg.type === 'agentClosed') getOfficeState().setAgentPaused(msg.id, false);
    });
  }, [getOfficeState]);
}
