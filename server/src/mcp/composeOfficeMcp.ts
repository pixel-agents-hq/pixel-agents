/**
 * The Pixel Office MCP composed for one surface: the ONE place its parts are
 * put together, for standalone (cli.ts) and VS Code (adapters/vscode/
 * vscodeOfficeMcp.ts) alike. A surface hands in its office facts and its
 * capabilities — its terminals and delivery guard, and launching / closing
 * where it can — and gets back one feature object, which the shared server
 * code (server.ts, httpServer.ts, clientMessageHandler.ts) and the VS Code
 * provider carry as their single `officeMcp`.
 */

import type { FastifyInstance } from 'fastify';

import type { ServerMessage } from '../../../core/src/messages.js';
import { createAgentsView } from './agentsView.js';
import type { OfficeFacts } from './officeFacts.js';
import { type AgentMcpAccess, OfficeMcp } from './officeMcp.js';
import { handleOfficeMcpMessage } from './officeMcpMessages.js';
import type { OfficeOperations } from './officeOperations.js';
import type { OfficeTool } from './tool.js';

/** What a surface brings to the Pixel Office MCP. */
export interface OfficeMcpSurface {
  facts: OfficeFacts;
  /** Defaults to every tool. */
  tools?: readonly OfficeTool[];
}

/** One office's Pixel Office MCP, as the server and the surface use it. */
export interface OfficeMcpFeature extends AgentMcpAccess {
  /** The operations its tools call (tests drive them directly too). */
  readonly office: OfficeOperations;
  /** Mount `/mcp` on the office server. */
  registerRoutes(app: FastifyInstance): void;
  /** The URL agents reach /mcp at, once the server listens. */
  setEndpoint(url: string): void;
  /**
   * Its part of a privileged office's connect snapshot: its settings at once,
   * then the Intro's ask while unanswered — after `afterHooksAsks`, so an office asked both shows this
   * step after the hooks one.
   */
  handshake(send: (message: ServerMessage) => void, afterHooksAsks?: Promise<unknown>): void;
  /** Answer one of an office's MCP messages (consent, its switches); false when it isn't one. */
  handleMessage(message: Record<string, unknown>): boolean;
  /** Revoke every token, stop following the store (shutdown). */
  dispose(): void;
}

export function composeOfficeMcp(surface: OfficeMcpSurface): OfficeMcpFeature {
  const { facts } = surface;
  const { store } = facts;

  const office: OfficeOperations = {
    agents: createAgentsView(facts),
  };
  const officeMcp = new OfficeMcp({ office, provider: facts.provider, tools: surface.tools });
  // Tokens die with their agents.
  officeMcp.attach(store);

  return {
    office,
    configFor: (agentId) => officeMcp.configFor(agentId),
    revoke: (agentId) => officeMcp.revoke(agentId),
    registerRoutes: (app) => officeMcp.registerRoutes(app),
    setEndpoint: (url) => officeMcp.setEndpoint(url),

    handshake(send, afterHooksAsks) {
      send(officeMcp.statusMessage());
      const ask = () => {
        const request = officeMcp.consentRequest();
        if (request) send(request);
      };
      if (afterHooksAsks) void afterHooksAsks.then(ask, ask);
      else ask();
    },

    handleMessage: (message) =>
      handleOfficeMcpMessage(message, {
        officeMcp,
        broadcast: (m) => store.broadcast({ ...m }),
      }),

    dispose() {
      // Every agent's token dies with the server (and its config files go).
      officeMcp.dispose();
    },
  };
}
