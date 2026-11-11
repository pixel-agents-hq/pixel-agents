/**
 * The PC shells as this office knows them, outside React (like
 * tutorial/tutorialStore.ts): the server's latest list (pcShellsLoaded — sent on
 * every change and in each connect's snapshot, so it is the whole truth), the
 * shell this office's last open was answered with, the close question its last ×
 * got, and its last refused open. A PC shell is not an agent: it has a card and,
 * where this office runs terminals, a pane, and lights its PC (OfficeState), and
 * nothing else.
 */

import { useSyncExternalStore } from 'react';

import type { PcShell, PcShellCloseQuestion } from '../../../core/src/messages.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { transport } from '../transport/index.js';

export interface PcShellEntry {
  shells: readonly PcShell[];
  /** The shell this office's open was answered with, numbered so a repeat still counts. */
  ready: { id: number; seq: number } | null;
  /** The question this office's × got (a command still runs), until answered or dismissed. */
  question: PcShellCloseQuestion | null;
  /** This office's last refused open, numbered. */
  rejected: { reason: string; seq: number } | null;
}

const EMPTY: PcShellEntry = { shells: [], ready: null, question: null, rejected: null };
let entry: PcShellEntry = EMPTY;
const listeners = new Set<() => void>();

/** Take a PC shell message (useExtensionMessages). Returns whether it was one. */
export function handlePcShellMessage(
  msg: { type?: unknown; [key: string]: unknown },
  os: OfficeState,
): boolean {
  if (msg.type === 'pcShellsLoaded') {
    if (!Array.isArray(msg.shells)) return true;
    const shells = msg.shells as PcShell[];
    os.setPcShells(shells);
    const live = new Set(shells.map((s) => s.id));
    update({
      ...entry,
      shells,
      // A question about a shell that has ended is moot.
      question: entry.question && live.has(entry.question.id) ? entry.question : null,
    });
    return true;
  }
  if (msg.type === 'pcShellReady') {
    if (typeof msg.id !== 'number') return true;
    update({ ...entry, ready: { id: msg.id, seq: (entry.ready?.seq ?? 0) + 1 } });
    return true;
  }
  if (msg.type === 'pcShellCloseQuestion') {
    if (typeof msg.id !== 'number') return true;
    update({ ...entry, question: msg as unknown as PcShellCloseQuestion });
    return true;
  }
  if (msg.type === 'pcShellRejected') {
    if (typeof msg.reason !== 'string') return true;
    console.warn(`[Webview] PC shell refused: ${msg.reason}`);
    update({ ...entry, rejected: { reason: msg.reason, seq: (entry.rejected?.seq ?? 0) + 1 } });
    return true;
  }
  return false;
}

export function pcShellEntry(): PcShellEntry {
  return entry;
}

export function subscribePcShells(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePcShells(): PcShellEntry {
  return useSyncExternalStore(subscribePcShells, pcShellEntry);
}

/**
 * Open a piece's PC shell (its live one, or a new one — in `directory`, the
 * Directory selector's pick, when given): answered with `ready`.
 */
export function openPcShell(uid: string, directory?: string | null): void {
  transport.send({ type: 'openPcShell', uid, ...(directory ? { directory } : {}) });
}

/** A shell card's ×; `confirmed` answers the question a running command raised. */
export function closePcShell(id: number, confirmed = false): void {
  if (entry.question?.id === id) update({ ...entry, question: null });
  transport.send({ type: 'closePcShell', id, ...(confirmed ? { confirmed: true } : {}) });
}

/** Leave the shell running: the question goes. */
export function dismissPcShellQuestion(): void {
  if (entry.question) update({ ...entry, question: null });
}

function update(next: PcShellEntry): void {
  entry = next;
  for (const l of listeners) l();
}

/** Tests only: forget everything. */
export function resetPcShellStoreForTests(): void {
  entry = EMPTY;
}
