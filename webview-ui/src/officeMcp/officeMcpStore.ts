/**
 * The Pixel Office MCP as this office knows it, outside React (like
 * usage/usageStore.ts): its settings (officeMcpStatus — only a privileged
 * office of a server that offers the MCP is ever sent one; absent = no MCP
 * here, so Settings shows no switch) and the Intro's ask
 * (officeMcpConsentRequest).
 *
 * The ask is a SNAPSHOT, like the hooks tour's (hooks/introTourState.ts): once
 * this office answered, the status that answer brings back must not yank the
 * step from the person who just answered — the tour keeps it until it closes.
 * An UNANSWERED ask whose status says another office answered is moot and
 * goes.
 */

import type { OfficeMcpConsentRequest, OfficeMcpStatus } from '../../../core/src/messages.js';

export interface OfficeMcpEntry {
  status?: OfficeMcpStatus;
  /** The Intro step to show, or null. */
  ask: OfficeMcpConsentRequest | null;
  /** This office answered the ask on screen (the tour holds it until it closes). */
  answered: boolean;
}

const EMPTY: OfficeMcpEntry = { ask: null, answered: false };
let entry: OfficeMcpEntry = EMPTY;
const listeners = new Set<() => void>();

/** Take an officeMcp* message (useExtensionMessages). Returns whether it was one. */
export function handleOfficeMcpMessage(msg: { type?: unknown; [key: string]: unknown }): boolean {
  if (msg.type === 'officeMcpStatus') {
    if (typeof msg.consent !== 'string' || typeof msg.readOnly !== 'boolean') return true;
    const status = msg as unknown as OfficeMcpStatus;
    const moot = entry.ask !== null && !entry.answered && status.consent !== 'unanswered';
    update({ ...entry, status, ...(moot ? { ask: null } : {}) });
    return true;
  }
  if (msg.type === 'officeMcpConsentRequest') {
    if (typeof msg.headline !== 'string' || typeof msg.disclosure !== 'string') return true;
    // An answered tour keeps its snapshot; a re-ask (a reconnect) refreshes an open one.
    if (!entry.answered) update({ ...entry, ask: msg as unknown as OfficeMcpConsentRequest });
    return true;
  }
  return false;
}

/** The ask on screen was answered (the caller sends the answer). */
export function markOfficeMcpAnswered(): void {
  if (entry.ask) update({ ...entry, answered: true });
}

/** The tour closed: the ask goes (an unanswered one returns on the next connect). */
export function dismissOfficeMcpAsk(): void {
  if (entry.ask || entry.answered) update({ ...entry, ask: null, answered: false });
}

/** The current entry; the same object until a message changes it. */
export function officeMcpEntry(): OfficeMcpEntry {
  return entry;
}

export function subscribeOfficeMcp(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function update(next: OfficeMcpEntry): void {
  entry = next;
  for (const l of listeners) l();
}

/** Tests only: forget everything. */
export function resetOfficeMcpStoreForTests(): void {
  entry = EMPTY;
}
