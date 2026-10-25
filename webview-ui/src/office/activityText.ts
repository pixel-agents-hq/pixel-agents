import type { ToolActivity } from './types.js';

/** Tool labels describe live tools only; generation between tools is working. */
export function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
  bubbleType: 'permission' | 'waiting' | null,
  waitingAwaitingInput: boolean,
): string {
  if (bubbleType === 'permission') return 'Needs approval';
  if (!isActive && bubbleType === 'waiting' && waitingAwaitingInput) return 'Waiting for input';
  const activeTool = [...(agentTools[agentId] ?? [])].reverse().find((tool) => !tool.done);
  if (activeTool) return activeTool.permissionWait ? 'Needs approval' : activeTool.status;
  return isActive ? 'Working' : 'Idle';
}
