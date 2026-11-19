/**
 * The Pixel Office MCP as the VS Code office composes it: the surface's facts
 * and capabilities handed to the one composition (server/src/mcp/
 * composeOfficeMcp.ts), over this window's store. Free of the `vscode`
 * module, so it is tested as it runs (server/__tests__/officeMcpVsCode.test.ts);
 * the provider hands in what only it holds (its terminals, loaded assets,
 * Directories).
 */

import type { CatalogSource } from '../../core/src/layout/index.js';
import type { AgentStateStore } from '../../server/src/agentStateStore.js';
import { readConfig, writeConfig } from '../../server/src/configPersistence.js';
import { readLayoutFromFile, writeLayoutToFile } from '../../server/src/layoutPersistence.js';
import { composeOfficeMcp, type OfficeMcpFeature } from '../../server/src/mcp/composeOfficeMcp.js';
import type { AssetCounts } from '../../server/src/mcp/officeFacts.js';
import { claudeProvider } from '../../server/src/providers/index.js';

/** What the office's assets are, once the webview's handshake loaded them. */
export interface VscodeOfficeAssets extends AssetCounts {
  catalog: readonly CatalogSource[];
}

export interface VscodeOfficeMcpDeps {
  store: AgentStateStore;
  /** The bundled default layout, for an office that saved none. */
  defaultLayout(): Record<string, unknown> | null;
  /** The loaded assets, or null before they are. */
  assets(): VscodeOfficeAssets | null;
  /** This window's Directories (workspace folders and the user's). */
  directories(): ReadonlyArray<{ name: string; path: string }>;
}

export function createVscodeOfficeMcp(deps: VscodeOfficeMcpDeps): OfficeMcpFeature {
  const { store } = deps;
  return composeOfficeMcp({
    facts: {
      store,
      provider: claudeProvider,
      layout: () => readLayoutFromFile() ?? deps.defaultLayout(),
      writeLayout: writeLayoutToFile,
      catalog: () => deps.assets()?.catalog ?? [],
      assets: () => {
        const assets = deps.assets();
        return {
          floorPatterns: assets?.floorPatterns ?? 0,
          wallSets: assets?.wallSets ?? 0,
          carpets: assets?.carpets ?? 0,
          pets: assets?.pets ?? [],
        };
      },
      directories: () => deps.directories(),
      seats: () => store.getAdapter()?.loadSeats() ?? {},
      readAreaMappings: () => readConfig().vscode.areaMappings ?? {},
      writeAreaMappings: (mappings) => {
        const cfg = readConfig();
        cfg.vscode.areaMappings = mappings;
        writeConfig(cfg);
      },
    },
  });
}
