/**
 * The Pixel Office MCP as the VS Code office composes it: the surface's facts
 * and capabilities handed to the one composition (server/src/mcp/
 * composeOfficeMcp.ts), over this window's store. Free of the `vscode`
 * module, so it is tested as it runs (server/__tests__/officeMcpVsCode.test.ts);
 * the provider hands in what only it holds (its terminals, loaded assets,
 * Directories).
 *
 * What differs from standalone:
 * - **Terminals can be typed into, not read** (`screenlessAgentTerminals`,
 *   guarded by `turnGuard`): read_agent_terminal gives status only, and
 *   send_message types text, no token, only into agents that are done or
 *   active.
 * - **No launching or closing**: launch_agent and close_agent aren't offered
 *   (VS Code's launch has none of launch_agent's asks — model, seat, resume —
 *   nor a way to tell when the CLI joined). The tutorial still runs: the
 *   window launches the Guide itself (`tutorial`), with its first message.
 */

import type { CatalogSource } from '../../core/src/layout/index.js';
import type { TerminalHandle } from '../../core/src/terminalAdapter.js';
import type { AgentStateStore } from '../../server/src/agentStateStore.js';
import { readConfig, writeConfig } from '../../server/src/configPersistence.js';
import { userDirectoryDefaults } from '../../server/src/directories.js';
import { writeLayoutToFile } from '../../server/src/layoutPersistence.js';
import { composeOfficeMcp, type OfficeMcpFeature } from '../../server/src/mcp/composeOfficeMcp.js';
import { turnGuard } from '../../server/src/mcp/messaging.js';
import type { AssetCounts } from '../../server/src/mcp/officeFacts.js';
import type { OfficePlaceFacts } from '../../server/src/officeFacts.js';
import { claudeProvider } from '../../server/src/providers/index.js';
import { screenlessAgentTerminals } from '../../server/src/terminal/agentTerminals.js';
import type { TutorialSurface } from '../../server/src/tutorial/tutorial.js';

/** What the office's assets are, once the webview's handshake loaded them. */
export interface VscodeOfficeAssets extends AssetCounts {
  catalog: readonly CatalogSource[];
}

export interface VscodeOfficeMcpDeps {
  store: AgentStateStore;
  /** Types into a terminal (the terminal adapter's sendText). */
  sendText(terminal: TerminalHandle, text: string): void;
  /** The window's layout, catalogue, Directories (workspace folders and the
   *  user's) and Area mappings: its one OfficePlaceFacts, the PC shells' too. */
  places: OfficePlaceFacts;
  /** The loaded assets, or null before they are. */
  assets(): VscodeOfficeAssets | null;
  /** Re-send the Directories and the roster's recency (an agent's Character edit moved them). */
  characterRefsChanged(): void;
  /** How this window launches the tutorial's Guide and ends it. */
  tutorial?: TutorialSurface;
}

export function createVscodeOfficeMcp(deps: VscodeOfficeMcpDeps): OfficeMcpFeature {
  const { store } = deps;
  const terminals = screenlessAgentTerminals(
    (id) => store.get(id)?.terminalRef,
    (terminal, text) => deps.sendText(terminal, text),
  );
  return composeOfficeMcp({
    facts: {
      ...deps.places,
      store,
      provider: claudeProvider,
      writeLayout: writeLayoutToFile,
      assets: () => {
        const assets = deps.assets();
        return {
          floorPatterns: assets?.floorPatterns ?? 0,
          wallSets: assets?.wallSets ?? 0,
          carpets: assets?.carpets ?? 0,
          pets: assets?.pets ?? [],
        };
      },
      userDirectories: userDirectoryDefaults,
      seats: () => store.getAdapter()?.loadSeats() ?? {},
      writeAreaMappings: (mappings) => {
        const cfg = readConfig();
        cfg.vscode.areaMappings = mappings;
        writeConfig(cfg);
      },
      characterRefsChanged: () => deps.characterRefsChanged(),
    },
    terminals,
    deliveryGuard: turnGuard(store, claudeProvider),
    tutorial: deps.tutorial,
  });
}
