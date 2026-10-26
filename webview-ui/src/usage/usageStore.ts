/**
 * Each provider's usage bridge state and plan usage, as the server last sent
 * them (usageBridgeStatus, usageLimits), outside React like
 * office/contextGauge.ts: the Intro, Settings and the usage bars all read the
 * same entry (useUsageBridge).
 *
 * `seq` counts usageBridgeStatus ARRIVALS. A failed install re-reports the
 * value already held, so only an arrival settles a request: a click remembers
 * the seq it saw, and the request is answered once seq moves on.
 */

import type { UsageBridgeStatus, UsageLimits } from '../../../core/src/messages.js';

export interface UsageEntry {
  status?: UsageBridgeStatus;
  limits?: UsageLimits;
  /** usageBridgeStatus arrivals so far. */
  seq: number;
}

const EMPTY: UsageEntry = { seq: 0 };
const entries = new Map<string, UsageEntry>();
const listeners = new Set<() => void>();

/** Take a usage message (useExtensionMessages). Returns whether it was one,
 *  accepted or not. A status needs a string providerId and a boolean
 *  installed; limits a string providerId. */
export function handleUsageMessage(msg: { type?: unknown; [key: string]: unknown }): boolean {
  if (msg.type === 'usageBridgeStatus') {
    if (typeof msg.providerId === 'string' && typeof msg.installed === 'boolean') {
      const status = msg as unknown as UsageBridgeStatus;
      const prev = usageEntry(status.providerId);
      update(status.providerId, { ...prev, status, seq: prev.seq + 1 });
    }
    return true;
  }
  if (msg.type === 'usageLimits') {
    if (typeof msg.providerId === 'string') {
      const limits = msg as unknown as UsageLimits;
      update(limits.providerId, { ...usageEntry(limits.providerId), limits });
    }
    return true;
  }
  return false;
}

/** A provider's entry; the same object until a message changes it. */
export function usageEntry(providerId: string): UsageEntry {
  return entries.get(providerId) ?? EMPTY;
}

/** Whether a request sent at `sentAtSeq` (null = none) still awaits its answer. */
export function awaitingAnswer(entry: UsageEntry, sentAtSeq: number | null): boolean {
  return sentAtSeq !== null && entry.seq === sentAtSeq;
}

export function subscribeUsage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function update(providerId: string, entry: UsageEntry): void {
  entries.set(providerId, entry);
  for (const l of listeners) l();
}

/** Tests only: forget every entry. */
export function resetUsageStoreForTests(): void {
  entries.clear();
}
