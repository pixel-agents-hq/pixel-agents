import { useSyncExternalStore } from 'react';

import type { AgentLook } from '../office/agentLook.js';
import { getAgentLook, getAgentLookVersion, subscribeAgentLook } from '../office/agentLook.js';

/** The current agent look (Clawd / Classic), re-rendering on change. */
export function useAgentLook(): AgentLook {
  return useSyncExternalStore(subscribeAgentLook, getAgentLook, getAgentLook);
}

/** Changes whenever any agent's drawing may have changed: the look, or a
 *  Clawd tint/accessory handed out as agents arrive (for the mug shots). */
export function useAgentLookVersion(): number {
  return useSyncExternalStore(subscribeAgentLook, getAgentLookVersion, getAgentLookVersion);
}
