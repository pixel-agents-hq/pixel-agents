import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentTexts: string[] = [];
const terminalOptions: Array<Record<string, unknown>> = [];

// agentManager.ts (and fileWatcher.ts under it) import 'vscode' at module load.
vi.mock('vscode', () => ({
  window: {
    activeTerminal: undefined,
    terminals: [],
    createTerminal: (options: Record<string, unknown>) => {
      terminalOptions.push(options);
      return {
        name: options.name,
        show: () => undefined,
        sendText: (text: string) => sentTexts.push(text),
      };
    },
  },
  workspace: { workspaceFolders: undefined },
}));

import { launchNewTerminal } from '../../adapters/vscode/agentManager.js';
import { vscodeCuratorRefusal } from '../../adapters/vscode/curatorGuard.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { CAPABILITY_ENV_NAME, CURATOR_UNAVAILABLE_REASON } from '../src/constants.js';

/**
 * The VS Code panel has no capabilities and no curators: its terminals are the
 * editor's, never the standalone PTY launcher's. These pin both halves.
 */
describe('VS Code surface: curators and capabilities', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;

  beforeEach(() => {
    vi.useFakeTimers();
    sentTexts.length = 0;
    terminalOptions.length = 0;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-vscode-curator-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = new AgentStateStore();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    store.dispose();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('refuses both curator requests with curatorRejected unavailable', () => {
    for (const message of [
      { type: 'setWorkspaceCurator', workspaceId: 'default', agentId: 1 },
      { type: 'unsetWorkspaceCurator', workspaceId: 'default' },
      { type: 'setWorkspaceCurator' },
      { type: 'unsetWorkspaceCurator', workspaceId: 42 },
    ]) {
      expect(vscodeCuratorRefusal(message)).toEqual({
        type: 'curatorRejected',
        code: 'unavailable',
        reason: CURATOR_UNAVAILABLE_REASON,
      });
    }
    expect(store.size).toBe(0);
  });

  it('lets every other message through untouched', () => {
    for (const type of ['launchAgent', 'webviewReady', 'closeAgent', 'removeWorkspace']) {
      expect(vscodeCuratorRefusal({ type })).toBeNull();
    }
  });

  it('launchNewTerminal never carries a capability', async () => {
    for (const bypass of [false, true]) {
      await launchNewTerminal(
        store.nextAgentId,
        store.nextTerminalIndex,
        store,
        { current: null },
        new Set(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        { current: null },
        () => undefined,
        tempHome,
        bypass,
        true,
      );
    }
    expect(sentTexts).toHaveLength(2);
    for (const text of sentTexts) {
      expect(text).not.toContain(CAPABILITY_ENV_NAME);
      expect(text).not.toContain('pxa_kb_');
    }
    expect(terminalOptions).toHaveLength(2);
    for (const options of terminalOptions) {
      expect(options.env).toBeUndefined();
      expect(JSON.stringify(options)).not.toContain('pxa_kb_');
    }
  });
});
