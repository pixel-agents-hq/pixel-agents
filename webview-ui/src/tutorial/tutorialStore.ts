/**
 * The tutorial as this office knows it, outside React (like
 * officeMcp/officeMcpStore.ts): the server's latest tutorialStatus (only a
 * privileged office of a server that offers the Pixel Office MCP is sent one;
 * absent = no tutorial here) and the last refusal of this office's start.
 */

import type { TutorialRejected, TutorialStatus } from '../../../core/src/messages.js';

export interface TutorialEntry {
  status?: TutorialStatus;
  /** The last tutorialRejected this office got, numbered so a repeat still counts. */
  rejected: { reason: string; seq: number } | null;
}

const EMPTY: TutorialEntry = { rejected: null };
let entry: TutorialEntry = EMPTY;
const listeners = new Set<() => void>();

/** Take a tutorial message (useExtensionMessages). Returns whether it was one. */
export function handleTutorialMessage(msg: { type?: unknown; [key: string]: unknown }): boolean {
  if (msg.type === 'tutorialStatus') {
    if (typeof msg.available !== 'boolean' || typeof msg.disclosure !== 'string') return true;
    update({ ...entry, status: msg as unknown as TutorialStatus });
    return true;
  }
  if (msg.type === 'tutorialRejected') {
    const reason = (msg as unknown as TutorialRejected).reason;
    if (typeof reason !== 'string') return true;
    update({ ...entry, rejected: { reason, seq: (entry.rejected?.seq ?? 0) + 1 } });
    return true;
  }
  return false;
}

export function tutorialEntry(): TutorialEntry {
  return entry;
}

export function subscribeTutorial(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function update(next: TutorialEntry): void {
  entry = next;
  for (const l of listeners) l();
}

/** Tests only: forget everything. */
export function resetTutorialStoreForTests(): void {
  entry = EMPTY;
}
