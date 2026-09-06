import { DEFAULT_MAX_CONTEXT_TOKENS } from './constants.js';
import type { AgentState } from './types.js';

type RequiredInit = 'id' | 'sessionId' | 'projectDir' | 'jsonlFile' | 'isExternal';

/** What a creation site must say about a new agent (identity + where its
 *  transcript lives + whether we own its process) and what it may override. */
export type AgentStateInit = Pick<AgentState, RequiredInit> &
  Partial<Omit<AgentState, RequiredInit>>;

/**
 * The ONE place a fresh AgentState's runtime scaffolding is spelled out: empty
 * tool maps, zeroed counters, no hooks seen yet, default context window. Every
 * creation path -- terminal launch (both surfaces), adoption, teammates, named
 * and unnamed background spawns, restore -- starts from here and states only
 * what makes it different, so adding a field to AgentState is one edit.
 */
export function createAgentState(init: AgentStateInit): AgentState {
  return {
    terminalRef: undefined,
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    hookDelivered: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    contextTokens: 0,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    ...init,
  };
}
