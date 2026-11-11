/**
 * The Pixel Office MCP composed for one surface: the ONE place its parts are
 * put together, for standalone (cli.ts) and VS Code (adapters/vscode/
 * vscodeOfficeMcp.ts) alike. A surface hands in its office facts and its
 * capabilities — its terminals and delivery guard, and launching / closing
 * where it can — and gets back one feature object, which the shared server
 * code (server.ts, httpServer.ts, clientMessageHandler.ts) and the VS Code
 * provider carry as their single `officeMcp`.
 */

import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';

import type { ServerMessage } from '../../../core/src/messages.js';
import type { AgentTerminals } from '../terminal/agentTerminals.js';
import { agentLabel } from './agentLabel.js';
import { createAgentsView } from './agentsView.js';
import { createLayoutEdits } from './layoutEdits.js';
import { createLayoutOps } from './layoutOps.js';
import { createClosing, createLaunching } from './lifecycle.js';
import { createMessaging, type DeliveryGuard } from './messaging.js';
import type { OfficeFacts } from './officeFacts.js';
import { type AgentMcpAccess, OfficeMcp } from './officeMcp.js';
import { handleOfficeMcpMessage } from './officeMcpMessages.js';
import type { AgentLaunch, AgentLaunchOutcome, OfficeOperations } from './officeOperations.js';
import { catalogOf } from './seatPlace.js';
import type { OfficeTool } from './tool.js';
import { createVisitOps } from './visitsOps.js';

/** What a surface brings to the Pixel Office MCP. */
export interface OfficeMcpSurface {
  facts: OfficeFacts;
  /** How it reads and writes its agents' terminals (Messages). */
  terminals: AgentTerminals;
  /** How a Message is checked before it is typed, and again before its Enter
   *  (messaging.ts: `screenTokenGuard` where screens can be read, `turnGuard` where not). */
  deliveryGuard: DeliveryGuard;
  /** How it launches an agent for launch_agent, waiting until it joined; the
   *  launch gets the MCP like any other (`mcp`). Absent: launch_agent isn't offered. */
  launch?(request: AgentLaunch, mcp: AgentMcpAccess): Promise<AgentLaunchOutcome>;
  /** How it ends an agent closed from close_agent (as its card's × does).
   *  Absent: close_agent isn't offered. */
  close?(id: number): void;
  /** Defaults to every tool. */
  tools?: readonly OfficeTool[];
}

/** One office's Pixel Office MCP, as the server and the surface use it. */
export interface OfficeMcpFeature extends AgentMcpAccess {
  /** The operations its tools call (tests drive them directly too). */
  readonly office: OfficeOperations;
  /** Mount `/mcp` on the office server. */
  registerRoutes(app: FastifyInstance): void;
  /** The URL agents reach /mcp at, once the server listens; null when this
   *  office's server is another's, reused (a second VS Code window), whose
   *  /mcp serves that office's agents and not this one's. */
  setEndpoint(url: string | null): void;
  /** Whether this office can hand the MCP to the agents it launches: its own
   *  server serves /mcp and its CLI takes an MCP config file. Where it can't,
   *  the office is neither asked nor shown the MCP's settings. */
  offered(): boolean;
  /**
   * Its part of a privileged office's connect snapshot, where the MCP is
   * offered: its settings and what an agent edit's undo would revert, then
   * the Intro's ask while unanswered — after `afterHooksAsks`, so an office
   * asked both shows this step after the hooks one. A handshake that comes
   * before the server has said whether it serves /mcp (`setEndpoint`) waits
   * for it.
   */
  handshake(send: (message: ServerMessage) => void, afterHooksAsks?: Promise<unknown>): void;
  /** Answer one of an office's MCP messages (consent, its switches, the editing
   *  lock, the editor's undo); false when it isn't one. `client` is the office
   *  sending it; replies meant for it alone go to `reply`. */
  handleMessage(
    message: Record<string, unknown>,
    client: object | undefined,
    reply: (message: ServerMessage) => void,
  ): boolean;
  /** An office saved the layout or the Area mappings: what an undo would revert may have changed. */
  layoutSaved(): void;
  /** An office went: its editing-lock report goes with it. */
  clientGone(client: object): void;
  /** Revoke every token, stop following the store (shutdown). */
  dispose(): void;
}

export function composeOfficeMcp(surface: OfficeMcpSurface): OfficeMcpFeature {
  const { facts, terminals } = surface;
  const { store } = facts;

  const layoutEdits = createLayoutEdits({
    readLayout: facts.layout,
    writeLayout: facts.writeLayout,
    catalog: () => catalogOf(facts.catalog()),
    assets: () => {
      const { floorPatterns, wallSets, carpets, pets } = facts.assets();
      return { floorPatterns, wallSets, carpets, pets: pets.length };
    },
    directories: () => facts.directories().map((d) => d.name),
    readAreaMappings: facts.readAreaMappings,
    writeAreaMappings: facts.writeAreaMappings,
    // The store's broadcast reaches every office of the surface.
    broadcast: (message) => store.broadcast(message),
    agentName: (id) => {
      const agent = store.get(id);
      return (agent && agentLabel(agent)) ?? `agent ${id}`;
    },
    newId: () => randomUUID(),
  });

  const visits = createVisitOps(facts);
  const closing = surface.close ? createClosing(facts, surface.close, terminals) : undefined;
  const launch = surface.launch;
  const office: OfficeOperations = {
    agents: createAgentsView(facts, (id) => terminals.has(id)),
    layout: createLayoutOps(facts, layoutEdits),
    messaging: createMessaging(store, terminals, surface.deliveryGuard),
    visits,
    // launch_agent's launch gives the agent this MCP, like any other launch.
    ...(launch ? { launch: createLaunching(facts, (request) => launch(request, officeMcp)) } : {}),
    ...(closing ? { close: closing } : {}),
  };
  const officeMcp = new OfficeMcp({ office, provider: facts.provider, tools: surface.tools });
  // Tokens die with their agents.
  officeMcp.attach(store);

  // Whether this office's server serves /mcp is known once it has started
  // (`setEndpoint`); a handshake before then waits for it rather than guess.
  let decided = false;
  let decide!: () => void;
  const whenDecided = new Promise<void>((resolve) => (decide = resolve));

  return {
    office,
    configFor: (agentId) => officeMcp.configFor(agentId),
    revoke: (agentId) => officeMcp.revoke(agentId),
    registerRoutes: (app) => officeMcp.registerRoutes(app),
    setEndpoint(url) {
      if (url !== null) officeMcp.setEndpoint(url);
      decided = true;
      decide();
    },
    offered: () => officeMcp.offered(),

    handshake(send, afterHooksAsks) {
      const offer = () => {
        if (!officeMcp.offered()) return;
        send(officeMcp.statusMessage());
        send(layoutEdits.statusMessage());
        const ask = () => {
          const request = officeMcp.consentRequest();
          if (request) send(request);
        };
        if (afterHooksAsks) void afterHooksAsks.then(ask, ask);
        else ask();
      };
      if (decided) offer();
      else void whenDecided.then(offer);
    },

    handleMessage: (message, client, reply) =>
      handleOfficeMcpMessage(message, {
        officeMcp,
        layoutEdits,
        client,
        broadcast: (m) => store.broadcast({ ...m }),
        reply,
      }),

    layoutSaved: () => layoutEdits.layoutSaved(),
    clientGone: (client) => layoutEdits.clientGone(client),

    dispose() {
      // Every agent's token dies with the server (and its config files go).
      officeMcp.dispose();
      visits.dispose();
      closing?.dispose();
    },
  };
}
