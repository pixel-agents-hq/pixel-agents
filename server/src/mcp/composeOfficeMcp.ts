/**
 * The Pixel Office MCP composed for one surface: the ONE place its parts are
 * put together, for standalone (cli.ts) and VS Code (adapters/vscode/
 * vscodeOfficeMcp.ts) alike. A surface hands in its office facts and its
 * capabilities — its terminals and delivery guard, and launching / closing
 * and PC shells where it can — and gets back one feature object, which the shared server
 * code (server.ts, httpServer.ts, clientMessageHandler.ts) and the VS Code
 * provider carry as their single `officeMcp`.
 */

import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';

import { greeterPalette } from '../../../core/src/greeterCharacter.js';
import type { ServerMessage } from '../../../core/src/messages.js';
import { characterRenderer } from '../characterArt.js';
import { commitCharacterProfiles } from '../characterProfilesPersistence.js';
import { getCharacterProfiles, getWardrobeItems } from '../characterProfilesStore.js';
import { getOfficeMcpConsent, readConfig } from '../configPersistence.js';
import {
  normalizeDirectoryPath,
  setDirectoryCharacters,
  writeUserDirectories,
} from '../directories.js';
import { catalogOf } from '../officeFacts.js';
import type { AgentTerminals } from '../terminal/agentTerminals.js';
import { writeOnboardingPlugin } from '../tutorial/onboardingPlugin.js';
import { Tutorial, type TutorialSurface } from '../tutorial/tutorial.js';
import { GUIDE_FALLBACK_NAME } from '../tutorial/tutorialCopy.js';
import { layoutSignature } from '../tutorial/tutorialSightings.js';
import { invalidateAttributionDirectories } from '../worktreeAttribution.js';
import { isRepo } from '../worktreeGit.js';
import { agentLabel } from './agentLabel.js';
import { createAgentsView } from './agentsView.js';
import type { EditDirectory } from './characterEditOps.js';
import { createCharacterEdits } from './characterEdits.js';
import { createCharacterOps } from './charactersView.js';
import { createDirectoryOps } from './directoryOps.js';
import { createLayoutEdits } from './layoutEdits.js';
import { createLayoutOps } from './layoutOps.js';
import { createClosing, createLaunching } from './lifecycle.js';
import { createMessaging, type DeliveryGuard } from './messaging.js';
import { type OfficeFacts, officeSnapshot } from './officeFacts.js';
import { type AgentMcpAccess, OfficeMcp } from './officeMcp.js';
import { handleOfficeMcpMessage } from './officeMcpMessages.js';
import type { AgentLaunch, AgentLaunchOutcome, OfficeOperations } from './officeOperations.js';
import { createPcShellOps, type McpPcShells } from './pcShellOps.js';
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
  /** Its PC shells, where their terminals can be read and written (standalone).
   *  Absent: the PC shell tools aren't offered. */
  pcShells?: McpPcShells;
  /** How it launches the tutorial's Guide and ends it. Absent: the
   *  Intro never offers the tutorial here. */
  tutorial?: TutorialSurface;
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
  /** Settings → Replay the Intro: the Intro's MCP ask again, whatever was
   *  answered, where the MCP is offered (`offered()`); elsewhere nothing. */
  replayAsk(send: (message: ServerMessage) => void): void;
  /** Answer one of an office's MCP messages (consent, its switches, the editing
   *  locks, the layout editor's and the Characters view's undo); false when it isn't one. `client` is the office
   *  sending it; replies meant for it alone go to `reply`. */
  handleMessage(
    message: Record<string, unknown>,
    client: object | undefined,
    reply: (message: ServerMessage) => void,
  ): boolean;
  /** An office saved the layout or the Area mappings: what an undo would revert
   *  may have changed, and the tutorial's layout quest may be done. */
  layoutSaved(): void;
  /** The roster or a Directory was saved by other means (a Characters-view Save, a Directory
   *  saved or removed, characters.json changed on disk): what a Character undo would revert
   *  may have changed. */
  charactersChanged(): void;
  /** An office went: its editing-lock reports (layout, characters) go with it. */
  clientGone(client: object): void;
  /** Revoke every token, stop following the store (shutdown). */
  dispose(): void;
}

export function composeOfficeMcp(surface: OfficeMcpSurface): OfficeMcpFeature {
  const { facts, terminals } = surface;
  const { store } = facts;

  const agentName = (id: number): string => {
    const agent = store.get(id);
    return (agent && agentLabel(agent)) ?? `agent ${id}`;
  };

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
    agentName,
    newId: () => randomUUID(),
  });

  const characterEdits = createCharacterEdits({
    profiles: getCharacterProfiles,
    renderer: () => characterRenderer(getWardrobeItems()),
    directories: () => editDirectories(facts.userDirectories(), facts.directories()),
    // The Characters view's Save path, without a saveId: every office takes it as a foreign list.
    commitProfiles: (profiles) =>
      commitCharacterProfiles(profiles, undefined, {
        broadcast: (message) => store.broadcast(message),
        store,
        // The save renumbered the Directories or the recency: re-send them, as a hand save
        // does (the batch's own Directory writes re-send them again, harmlessly).
        sharedRefsChanged: facts.characterRefsChanged,
      }) !== null,
    writeDirectoryCharacters: setDirectoryCharacters,
    characterRefsChanged: facts.characterRefsChanged,
    agentName,
    broadcast: (message) => store.broadcast(message),
  });

  const directories = createDirectoryOps({
    userDirectories: () => readConfig().directories,
    officeDirectories: facts.directories,
    writeUserDirectories,
    profiles: getCharacterProfiles,
    areas: () => (officeSnapshot(facts).layout?.areas ?? []).map((a) => a.label),
    readAreaMappings: facts.readAreaMappings,
    writeAreaMappings: facts.writeAreaMappings,
    isRepo,
    directoriesChanged: () => {
      invalidateAttributionDirectories();
      // Re-sent to every office, as a Directory saved in the modal is.
      facts.characterRefsChanged();
      // A Directory's defaults an agent's Character edit wrote may have moved.
      characterEdits.charactersChanged();
    },
    mappingsChanged: (mappings) => {
      store.broadcast({ type: 'areaMappingsLoaded', mappings });
      // The mappings an agent's layout edit wrote may have moved.
      layoutEdits.layoutSaved();
    },
  });

  const visits = createVisitOps(facts);
  // Its MCP access is this feature's own (`officeMcp`, below): read at launch time.
  const tutorial = new Tutorial({
    store,
    surface: surface.tutorial,
    // The Guide's skill sends it to the MCP's tools: no MCP here, no tutorial.
    mcpUnavailable: () => {
      if (officeMcp.offered()) return null;
      if (!facts.provider.mcpConfigFile) {
        return `The tutorial runs on the Pixel Agents Office MCP, which ${facts.provider.displayName} can't be given.`;
      }
      return decided
        ? "This window shares another window's office: start the tutorial from that one."
        : 'The office is still starting.';
    },
    mcpGranted: () => getOfficeMcpConsent() === 'granted',
    mcp: {
      configFor: (agentId) => officeMcp.configFor(agentId),
      revoke: (agentId) => officeMcp.revoke(agentId),
    },
    readFacts: () => ({
      characterIds: getCharacterProfiles().flatMap((p) => (p.id ? [p.id] : [])),
      directoryPaths: readConfig().directories.map((d) => d.path),
      layout: layoutSignature(facts.layout()),
      agentIds: [...store.entries()].map(([id]) => id),
    }),
    guideName: (palette) => {
      const cast = getCharacterProfiles();
      return cast[palette ?? greeterPalette(cast)]?.name || GUIDE_FALLBACK_NAME;
    },
    skills: facts.provider.skills,
    writePlugin: (name) =>
      facts.provider.skills ? writeOnboardingPlugin(facts.provider.skills, name) : undefined,
  });
  const closing = surface.close ? createClosing(facts, surface.close, terminals) : undefined;
  const launch = surface.launch;
  const office: OfficeOperations = {
    agents: createAgentsView(facts, (id) => terminals.has(id)),
    layout: createLayoutOps(facts, layoutEdits),
    messaging: createMessaging(store, terminals, surface.deliveryGuard),
    visits,
    characters: createCharacterOps(facts, characterEdits),
    directories,
    tutorial,
    // launch_agent's launch gives the agent this MCP, like any other launch.
    ...(launch ? { launch: createLaunching(facts, (request) => launch(request, officeMcp)) } : {}),
    ...(closing ? { close: closing } : {}),
    ...(surface.pcShells ? { shells: createPcShellOps(surface.pcShells) } : {}),
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

    replayAsk(send) {
      if (officeMcp.offered()) send(officeMcp.replayedConsentRequest());
    },

    handshake(send, afterHooksAsks) {
      const offer = () => {
        if (!officeMcp.offered()) return;
        send(officeMcp.statusMessage());
        send(layoutEdits.statusMessage());
        send(characterEdits.statusMessage());
        send(tutorial.statusMessage());
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

    handleMessage(message, client, reply) {
      if (tutorial.handleMessage(message, reply)) return true;
      const handled = handleOfficeMcpMessage(message, {
        officeMcp,
        layoutEdits,
        characterEdits,
        client,
        broadcast: (m) => store.broadcast({ ...m }),
        reply,
      });
      // The consent decides whether the tutorial can be offered.
      if (message.type === 'officeMcpConsentResponse' || message.type === 'setOfficeMcpEnabled') {
        tutorial.broadcastStatus();
      }
      return handled;
    },

    layoutSaved() {
      layoutEdits.layoutSaved();
      tutorial.layoutSavedByOffice();
    },
    charactersChanged: () => characterEdits.charactersChanged(),
    clientGone: (client) => {
      layoutEdits.clientGone(client);
      characterEdits.clientGone(client);
    },

    dispose() {
      // Every agent's token dies with the server (and its config files go).
      officeMcp.dispose();
      tutorial.dispose();
      visits.dispose();
      closing?.dispose();
    },
  };
}

/**
 * The Directories a Character edit may name: every Directory of the office, the
 * user's own (config.json) with their default characters, the host's with none
 * (a host Directory has no defaults of its own; a user entry at its path wins).
 */
function editDirectories(
  users: ReturnType<OfficeFacts['userDirectories']>,
  office: ReturnType<OfficeFacts['directories']>,
): EditDirectory[] {
  const userPaths = new Set(users.map((d) => normalizeDirectoryPath(d.path)));
  return [
    ...users.map((d) => ({ name: d.name, path: d.path, characters: d.characters })),
    ...office
      .filter((d) => !userPaths.has(normalizeDirectoryPath(d.path)))
      .map((d) => ({ name: d.name, path: d.path, characters: null })),
  ];
}
