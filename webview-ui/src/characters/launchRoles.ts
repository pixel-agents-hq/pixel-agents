/**
 * The roles a character can launch as: the agent definitions the server found in
 * ~/.claude/agents and each Directory's .claude/agents (`launchRolesLoaded`, sent to the
 * asker only). Asked for when the Characters view opens; null until the first answer.
 */

import { useSyncExternalStore } from 'react';

import type { LaunchRole, LaunchRolesLoaded } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';

let roles: readonly LaunchRole[] | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getRoles = () => roles;

/** Ask the server for the current roles (the files may have changed since last time). */
export function requestLaunchRoles(): void {
  transport.send({ type: 'requestLaunchRoles' });
}

/** Handle `launchRolesLoaded`; false when `msg` isn't one. */
export function handleLaunchRolesMessage(msg: { type?: unknown }): boolean {
  if (msg.type !== 'launchRolesLoaded') return false;
  const list = (msg as LaunchRolesLoaded).roles;
  roles = Array.isArray(list) ? list : [];
  for (const listener of listeners) listener();
  return true;
}

/** The roles, re-rendering when they arrive; null before the server has answered. */
export function useLaunchRoles(): readonly LaunchRole[] | null {
  return useSyncExternalStore(subscribe, getRoles);
}
