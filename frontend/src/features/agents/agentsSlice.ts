import { createSlice } from '@reduxjs/toolkit';

import { TOOL_LOG_LIMIT } from '../../constants';
import { DEFAULT_WORKSPACE_ID } from '../../protocol';
import type { AgentActivityStatus, GuardInactiveReason, PermissionRole } from '../../protocol';
import { serverMessageReceived } from '../connection/actions';

export interface ToolActivity {
  toolId: string;
  status: string;
  toolName?: string;
  startedAt: number;
  done: boolean;
}

export interface AgentGuard {
  active: boolean;
  reasons: GuardInactiveReason[];
  permissionRoles: PermissionRole[] | null;
}

export interface Agent {
  id: number;
  directoryName: string | null;
  workspaceId: string;
  roleName: string | null;
  isExternal: boolean;
  status: AgentActivityStatus;
  awaitingInput: boolean;
  permissionPending: boolean;
  tools: ToolActivity[];
  contextTokens: number | null;
  maxContextTokens: number | null;
  guard: AgentGuard | null;
  startedAt: number;
}

interface AgentsState {
  byId: Record<number, Agent>;
  order: number[];
}

const initialState: AgentsState = { byId: {}, order: [] };

function newAgent(id: number, startedAt: number): Agent {
  return {
    id,
    directoryName: null,
    workspaceId: DEFAULT_WORKSPACE_ID,
    roleName: null,
    isExternal: false,
    status: 'waiting',
    awaitingInput: false,
    permissionPending: false,
    tools: [],
    contextTokens: null,
    maxContextTokens: null,
    guard: null,
    startedAt,
  };
}

const agentsSlice = createSlice({
  name: 'agents',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder.addCase(serverMessageReceived, (state, { payload: message, meta }) => {
      switch (message.type) {
        case 'existingAgents': {
          const next: Record<number, Agent> = {};
          for (const id of message.agents) {
            const key = String(id);
            next[id] = {
              ...(state.byId[id] ?? newAgent(id, meta.receivedAt)),
              directoryName: message.directoryNames[key] ?? null,
              workspaceId: message.workspaceIds?.[key] ?? DEFAULT_WORKSPACE_ID,
              roleName: message.roleNames?.[key] ?? null,
              isExternal: message.externalAgents[key] ?? false,
            };
          }
          state.byId = next;
          state.order = message.agents;
          break;
        }
        case 'agentCreated':
          if (!state.byId[message.id]) state.order.push(message.id);
          state.byId[message.id] = {
            ...(state.byId[message.id] ?? newAgent(message.id, meta.receivedAt)),
            directoryName: message.directoryName ?? null,
            workspaceId: message.workspaceId ?? DEFAULT_WORKSPACE_ID,
            roleName: message.roleName ?? null,
            isExternal: message.isExternal ?? false,
          };
          break;
        case 'agentClosed':
          delete state.byId[message.id];
          state.order = state.order.filter((id) => id !== message.id);
          break;
        case 'agentWorkspaceChanged':
          if (state.byId[message.id]) state.byId[message.id].workspaceId = message.workspaceId;
          break;
        case 'agentStatus':
          if (state.byId[message.id]) {
            state.byId[message.id].status = message.status;
            state.byId[message.id].awaitingInput = message.awaitingInput ?? false;
          }
          break;
        case 'agentToolStart': {
          const agent = state.byId[message.id];
          if (!agent) break;
          agent.tools.push({
            toolId: message.toolId,
            status: message.status,
            toolName: message.toolName,
            startedAt: meta.receivedAt,
            done: false,
          });
          if (agent.tools.length > TOOL_LOG_LIMIT) agent.tools.shift();
          if (message.permissionActive) agent.permissionPending = true;
          break;
        }
        case 'agentToolDone': {
          const tool = state.byId[message.id]?.tools.find((t) => t.toolId === message.toolId);
          if (tool) tool.done = true;
          break;
        }
        case 'agentToolsClear':
          if (state.byId[message.id]) {
            for (const tool of state.byId[message.id].tools) tool.done = true;
            state.byId[message.id].permissionPending = false;
          }
          break;
        case 'agentToolPermission':
          if (state.byId[message.id]) state.byId[message.id].permissionPending = true;
          break;
        case 'agentToolPermissionClear':
          if (state.byId[message.id]) state.byId[message.id].permissionPending = false;
          break;
        case 'agentContextUsage':
          if (state.byId[message.id]) {
            state.byId[message.id].contextTokens = message.contextTokens;
            state.byId[message.id].maxContextTokens = message.maxContextTokens;
          }
          break;
        case 'agentGuardStatus':
          if (state.byId[message.id]) {
            state.byId[message.id].guard = {
              active: message.active,
              reasons: message.reasons,
              permissionRoles: message.permissionRoles,
            };
          }
          break;
      }
    });
  },
});

export const agentsReducer = agentsSlice.reducer;
