/**
 * The inbox's client state as a pure reducer (Node-tested): what the server
 * sent (agentLink, agentLimit) plus the two wait clocks the existing messages
 * don't carry -- when a permission was asked and when a question tool went
 * live. inboxStore.ts keeps the one live copy.
 */

import type { ServerMessage } from '../../../core/src/messages.js';
import { ZONE_ASK_USER_TOOL_NAME } from '../constants.js';
import type { AgentLimitState, AgentLinkState } from './inboxModel.js';

export interface InboxState {
  links: Record<number, AgentLinkState>;
  /** Agents paused by a usage limit right now. */
  limits: Record<number, AgentLimitState>;
  /** Live AskUserQuestion tools per agent: toolId -> when it started. */
  asking: Record<number, Record<string, number>>;
  /** When each agent's pending permission was first asked. */
  permissionSince: Record<number, number>;
}

export const EMPTY_INBOX: InboxState = { links: {}, limits: {}, asking: {}, permissionSince: {} };

function without<T>(record: Record<number, T>, id: number): Record<number, T> {
  if (!(id in record)) return record;
  const next = { ...record };
  delete next[id];
  return next;
}

/** One server message applied to the inbox state (identity kept when nothing changed). */
export function reduceInbox(state: InboxState, msg: ServerMessage, now: number): InboxState {
  switch (msg.type) {
    case 'agentLink': {
      const link: AgentLinkState = msg.url
        ? { url: msg.url, resumeCommand: msg.resumeCommand }
        : { resumeCommand: msg.resumeCommand };
      return { ...state, links: { ...state.links, [msg.id]: link } };
    }
    case 'agentLimit': {
      if (!msg.paused) return { ...state, limits: without(state.limits, msg.id) };
      const limit: AgentLimitState = {};
      if (msg.reason) limit.reason = msg.reason;
      if (msg.resetsAt !== undefined) limit.resetsAt = msg.resetsAt;
      return { ...state, limits: { ...state.limits, [msg.id]: limit } };
    }
    case 'agentToolStart': {
      let next = state;
      if (msg.toolName === ZONE_ASK_USER_TOOL_NAME) {
        const tools = state.asking[msg.id] ?? {};
        if (!(msg.toolId in tools)) {
          next = { ...next, asking: { ...next.asking, [msg.id]: { ...tools, [msg.toolId]: now } } };
        }
      }
      if (msg.permissionActive && !(msg.id in next.permissionSince)) {
        next = { ...next, permissionSince: { ...next.permissionSince, [msg.id]: now } };
      }
      return next;
    }
    case 'agentToolDone': {
      const tools = state.asking[msg.id];
      if (!tools || !(msg.toolId in tools)) return state;
      const rest = { ...tools };
      delete rest[msg.toolId];
      return {
        ...state,
        asking:
          Object.keys(rest).length > 0
            ? { ...state.asking, [msg.id]: rest }
            : without(state.asking, msg.id),
      };
    }
    case 'agentToolsClear':
      return {
        ...state,
        asking: without(state.asking, msg.id),
        permissionSince: without(state.permissionSince, msg.id),
      };
    case 'agentToolPermission':
      if (msg.id in state.permissionSince) return state;
      return { ...state, permissionSince: { ...state.permissionSince, [msg.id]: now } };
    case 'agentToolPermissionClear':
      return { ...state, permissionSince: without(state.permissionSince, msg.id) };
    case 'agentClosed':
      return {
        links: without(state.links, msg.id),
        limits: without(state.limits, msg.id),
        asking: without(state.asking, msg.id),
        permissionSince: without(state.permissionSince, msg.id),
      };
    default:
      return state;
  }
}
