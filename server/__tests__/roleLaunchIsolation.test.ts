import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentTexts: string[] = [];

// agentManager.ts (and fileWatcher.ts under it) import 'vscode' at module load.
vi.mock('vscode', () => ({
  window: {
    activeTerminal: undefined,
    terminals: [],
    createTerminal: (options: { name: string; cwd: string }) => ({
      name: options.name,
      show: () => undefined,
      sendText: (text: string) => sentTexts.push(text),
    }),
  },
  workspace: { workspaceFolders: undefined },
}));

import { launchNewTerminal } from '../../adapters/vscode/agentManager.js';
import { vscodeRoleLaunchRefusal } from '../../adapters/vscode/roleLaunchGuard.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';

const FLAG = '--append-system-prompt-file';
const SESSION = '11111111-1111-4111-8111-111111111111';

/**
 * The Role flag reaches claude only through the standalone launcher. These pin
 * the other side: the launch command without a Role is byte-for-byte what it
 * was, and the VS Code surface can never carry the flag.
 */
describe('claude buildLaunchCommand', () => {
  it('is unchanged without a Role', () => {
    expect(claudeProvider.buildLaunchCommand!(SESSION, '/w')).toEqual({
      command: 'claude',
      args: ['--session-id', SESSION],
      env: { PWD: '/w' },
    });
    expect(claudeProvider.buildLaunchCommand!(SESSION, '/w', { bypassPermissions: false })).toEqual(
      {
        command: 'claude',
        args: ['--session-id', SESSION],
        env: { PWD: '/w' },
      },
    );
    expect(claudeProvider.buildLaunchCommand!(SESSION, '/w', { bypassPermissions: true })).toEqual({
      command: 'claude',
      args: ['--session-id', SESSION, '--dangerously-skip-permissions'],
      env: { PWD: '/w' },
    });
  });

  it('appends the snapshot path as its own argv element with a Role', () => {
    const snapshot = '/home/me/.pixel-agents/roles/snapshots/1/a b.md';
    expect(
      claudeProvider.buildLaunchCommand!(SESSION, '/w', {
        bypassPermissions: true,
        appendSystemPromptFile: snapshot,
      }).args,
    ).toEqual(['--session-id', SESSION, '--dangerously-skip-permissions', FLAG, snapshot]);
  });
});

describe('VS Code surface', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;

  beforeEach(() => {
    vi.useFakeTimers();
    sentTexts.length = 0;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-vscode-role-'));
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

  async function launch(bypassPermissions: boolean): Promise<void> {
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
      bypassPermissions,
      true,
    );
  }

  it('launchNewTerminal never types the Role flag', async () => {
    await launch(false);
    await launch(true);
    expect(sentTexts).toHaveLength(2);
    expect(sentTexts[0]).toMatch(/^claude --session-id [0-9a-f-]{36}$/);
    expect(sentTexts[1]).toMatch(
      /^claude --session-id [0-9a-f-]{36} --dangerously-skip-permissions$/,
    );
    for (const text of sentTexts) expect(text).not.toContain(FLAG);
    for (const [, agent] of store) expect(agent.roleName).toBeUndefined();
  });

  it('refuses a launchAgent carrying any roleId with roleRejected unavailable', () => {
    for (const roleId of ['frontend.md', '', null, ['x'], 0]) {
      expect(vscodeRoleLaunchRefusal({ type: 'launchAgent', roleId })).toMatchObject({
        type: 'roleRejected',
        code: 'unavailable',
      });
    }
    expect(vscodeRoleLaunchRefusal({ type: 'launchAgent' })).toBeNull();
    expect(vscodeRoleLaunchRefusal({ type: 'launchAgent', directoryPath: '/w' })).toBeNull();
  });
});
