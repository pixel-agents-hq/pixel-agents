import type { AgentState } from './types.js';

/**
 * The Directory an agent works in, as a real path: where a running standalone
 * agent was launched (`directoryRealPath`), or where a stopped record will
 * start (`launchDirectory`). Undefined for agents observed from outside, which
 * have no launch Directory. Clients compare Directories by this path, never by
 * the Directory's display name (names are neither unique nor always present).
 */
export function agentDirectoryPath(agent: AgentState): string | undefined {
  return agent.directoryRealPath ?? agent.launchDirectory;
}
