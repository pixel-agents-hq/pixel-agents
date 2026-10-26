import type { TabStatus } from './AgentCard.js';

/** A status dot's colour, as text: the dot is the round `dot` pixel icon,
 *  drawn in currentColor (agent cards and the conversation list's running rows). */
export const STATUS_DOT: Record<TabStatus, string> = {
  idle: 'text-status-success', // green — turn complete, nothing pending
  working: 'text-accent-bright', // blue — actively running
  attention: 'text-status-permission', // yellow — needs permission or input
  disconnected: 'text-status-error', // red — terminal socket dropped
};
