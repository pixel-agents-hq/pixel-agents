import * as fs from 'fs';
import * as path from 'path';

import type { AgentStateStore } from './agentStateStore.js';
import type { LoadedAssets, LoadedCharacterSprites } from './assetLoader.js';
import { readLayoutFromFile } from './layoutPersistence.js';
import { claudeProvider } from './providers/index.js';

type WsSend = (message: Record<string, unknown>) => void;

/** Cached assets loaded at server startup. Sent to each WebSocket client on webviewReady. */
export interface AssetCache {
  characters: LoadedCharacterSprites | null;
  floorTiles: string[][][] | null;
  wallTiles: string[][][][] | null;
  furniture: LoadedAssets | null;
  defaultLayout: Record<string, unknown> | null;
}

/**
 * Handle incoming ClientMessage from a WebSocket client.
 *
 * In standalone mode, the server is the authority for all state: assets,
 * layout, settings, agents. Assets are loaded once at startup and cached
 * in memory. Each connecting client receives the full state on webviewReady.
 */
export function handleClientMessage(
  msg: Record<string, unknown>,
  store: AgentStateStore,
  send: WsSend,
  cache: AssetCache | null,
): void {
  switch (msg.type) {
    case 'webviewReady':
      handleWebviewReady(store, send, cache);
      break;

    case 'saveLayout':
      if (msg.layout) {
        import('./layoutPersistence.js').then(({ writeLayoutToFile }) => {
          writeLayoutToFile(msg.layout as Record<string, unknown>);
        });
      }
      break;

    case 'saveAgentSeats':
      if (msg.seats) {
        store
          .getAdapter()
          ?.saveSeats(
            msg.seats as Record<string, { palette?: number; hueShift?: number; seatId?: string }>,
          );
      }
      break;

    case 'setSoundEnabled':
      store.getAdapter()?.setSetting('pixel-agents.soundEnabled', msg.enabled);
      break;

    default:
      // focusAgent, exportLayout, importLayout
      // require IDE-specific handling (not yet implemented for standalone)
      break;
  }
}

function handleWebviewReady(store: AgentStateStore, send: WsSend, cache: AssetCache | null): void {
  // 1. Provider capabilities (must arrive before any agent messages)
  send({
    type: 'providerCapabilities',
    readingTools: [...claudeProvider.readingTools],
    subagentToolNames: [...claudeProvider.subagentToolNames],
  });

  // 2. Assets (from server cache, loaded at startup via pngjs)
  if (cache) {
    if (cache.characters) {
      send({ type: 'characterSpritesLoaded', characters: cache.characters.characters });
    }
    if (cache.floorTiles) {
      send({ type: 'floorTilesLoaded', sprites: cache.floorTiles });
    }
    if (cache.wallTiles) {
      send({ type: 'wallTilesLoaded', sets: cache.wallTiles });
    }
    if (cache.furniture) {
      send({
        type: 'furnitureAssetsLoaded',
        catalog: cache.furniture.catalog,
        // Map -> plain object for JSON serialization
        sprites: Object.fromEntries(cache.furniture.sprites),
      });
    }
  }

  // 3. Layout (saved file, or bundled default)
  const savedLayout = readLayoutFromFile();
  send({ type: 'layoutLoaded', layout: savedLayout ?? cache?.defaultLayout ?? null });

  // 4. Settings (defaults for standalone mode)
  const version = (() => {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8'),
      ) as { version?: string };
      return pkg.version ?? '';
    } catch {
      return '';
    }
  })();

  send({
    type: 'settingsLoaded',
    soundEnabled: false,
    lastSeenVersion: '',
    extensionVersion: version,
    watchAllSessions: false,
    alwaysShowLabels: false,
    hooksEnabled: true,
    hooksInfoShown: false,
    externalAssetDirectories: [],
  });

  // 5. Existing agents
  const agentIds: number[] = [];
  const folderNames: Record<number, string> = {};
  const externalAgents: Record<number, boolean> = {};
  for (const [id, agent] of store) {
    agentIds.push(id);
    if (agent.folderName) {
      folderNames[id] = agent.folderName;
    }
    if (agent.isExternal) {
      externalAgents[id] = true;
    }
  }
  const seats = store.getAdapter()?.loadSeats() ?? {};
  send({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta: seats,
    folderNames,
    externalAgents,
  });
}
