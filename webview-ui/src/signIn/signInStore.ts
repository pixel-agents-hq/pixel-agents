/**
 * Each provider's sign-in state as the server last answered it
 * (cliSignInStatus), outside React like usage/usageStore.ts. `seq` counts
 * ARRIVALS: an answer can repeat the value already held (still signed out),
 * so only an arrival settles a request.
 */

import type { CliSignInStatus } from '../../../core/src/messages.js';

export interface SignInEntry {
  status?: CliSignInStatus;
  /** cliSignInStatus arrivals so far. */
  seq: number;
}

const EMPTY: SignInEntry = { seq: 0 };
const entries = new Map<string, SignInEntry>();
const listeners = new Set<() => void>();

/** Take a sign-in message (useExtensionMessages). Returns whether it was one, accepted or not. */
export function handleSignInMessage(msg: { type?: unknown; [key: string]: unknown }): boolean {
  if (msg.type !== 'cliSignInStatus') return false;
  if (typeof msg.providerId === 'string' && typeof msg.signedIn === 'boolean') {
    const status: CliSignInStatus = {
      type: 'cliSignInStatus',
      providerId: msg.providerId,
      signedIn: msg.signedIn,
      ...(msg.planLimits === false ? { planLimits: false } : {}),
      ...(msg.cliMissing === true ? { cliMissing: true } : {}),
      ...(typeof msg.signInUrl === 'string' && isWebAddress(msg.signInUrl)
        ? { signInUrl: msg.signInUrl, openedOnHost: msg.openedOnHost === true }
        : {}),
      ...(typeof msg.error === 'string' ? { error: msg.error } : {}),
    };
    const prev = signInEntry(status.providerId);
    entries.set(status.providerId, { status, seq: prev.seq + 1 });
    for (const listener of listeners) listener();
  }
  return true;
}

/** Only an https page is ever opened or linked. */
function isWebAddress(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** A provider's entry; the same object until a message changes it. */
export function signInEntry(providerId: string): SignInEntry {
  return entries.get(providerId) ?? EMPTY;
}

export function subscribeSignIn(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a host name is this machine's own (the office is open where the server runs). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1'
  );
}
