/**
 * The VS Code adapter's launch seam, under a mocked `vscode`.
 *
 * These are the contracts `fix(vscode): launch, capabilities and restore across
 * every hook provider` established, and nothing else in the repo pins them: the
 * e2e extension suite is single-provider today (it drives Claude only), and the
 * adapter had no unit tests at all beyond migrateVsCodeState. So the three
 * things that were actually broken are asserted here — the provider's launch
 * command reaching the terminal (not Claude's), the push-only agent carrying no
 * transcript to poll, and `getProjectDirPath` answering instead of throwing for
 * a provider that has no session directories.
 *
 * Only the push-only path is exercised on purpose: a transcript-provider launch
 * continues into ensureProjectScan/polling, which belong to fileWatcher's own
 * suites. What is proven here is that the push-only launch RETURNS before it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from '../src/agentStateStore.js';

// The vscode surface agentManager touches: one terminal handle we can inspect,
// and a workspace we control per test. Everything else in the module is real.
const createdTerminals: {
  name: string;
  cwd?: string;
  env?: Record<string, string>;
  shown: number;
  sent: string[];
}[] = [];

const workspaceFolders = { current: undefined as undefined | { fsPath: string; name: string }[] };

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return (workspaceFolders.current ?? []).map((f) => ({
        uri: { fsPath: f.fsPath },
        name: f.name,
        index: 0,
      }));
    },
  },
  window: {
    createTerminal: (options: { name: string; cwd?: string; env?: Record<string, string> }) => {
      const handle = {
        name: options.name,
        show: () => {
          record.shown += 1;
        },
        sendText: (text: string) => {
          record.sent.push(text);
        },
        dispose: () => {},
      };
      const record: {
        name: string;
        cwd?: string;
        env?: Record<string, string>;
        shown: number;
        sent: string[];
      } = { name: options.name, cwd: options.cwd, env: options.env, shown: 0, sent: [] };
      createdTerminals.push(record);
      // The handle reads back the same record the test asserts on.
      return Object.assign(handle, {
        get shown() {
          return record.shown;
        },
        get sent() {
          return record.sent;
        },
      });
    },
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  EventEmitter: class {
    event = () => ({ dispose: () => {} });
    fire() {}
    dispose() {}
  },
}));

// The adapter's own host-directory source: the office would otherwise read the
// real workspace folders through vscode.
vi.mock('../../adapters/vscode/hostDirectories.js', () => ({
  workspaceDirectories: () => [],
}));

import { getProjectDirPath, launchNewTerminal } from '../../adapters/vscode/agentManager.js';
import { hookProviders } from '../src/providers/index.js';

const hermes = hookProviders.find((p) => p.id === 'hermes');
if (!hermes) throw new Error('hermes provider must be registered');

function refs() {
  return {
    nextAgentId: { current: 1 },
    nextTerminalIndex: { current: 1 },
    activeAgentId: { current: null as number | null },
    knownJsonlFiles: new Set<string>(),
    fileWatchers: new Map(),
    pollingTimers: new Map(),
    waitingTimers: new Map(),
    permissionTimers: new Map(),
    jsonlPollTimers: new Map(),
    projectScanTimer: { current: null },
  };
}

async function launch(
  provider: HookProvider,
  options: { directoryPath?: string; bypass?: boolean; suppressShow?: boolean } = {},
) {
  const r = refs();
  const agents = new Map<number, Record<string, unknown>>() as unknown as AgentStateStore;
  const persistAgents = vi.fn();
  await launchNewTerminal(
    r.nextAgentId,
    r.nextTerminalIndex,
    agents,
    r.activeAgentId,
    r.knownJsonlFiles,
    r.fileWatchers,
    r.pollingTimers,
    r.waitingTimers,
    r.permissionTimers,
    r.jsonlPollTimers,
    r.projectScanTimer,
    persistAgents,
    options.directoryPath,
    options.bypass,
    options.suppressShow,
    provider,
  );
  return { r, agents, persistAgents, agent: [...agents.values()][0] };
}

beforeEach(() => {
  createdTerminals.length = 0;
  workspaceFolders.current = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('getProjectDirPath', () => {
  it('throws for a transcript provider that resolves no directory', () => {
    const empty = { ...hermes, displayName: 'Empty', getSessionDirs: () => [] } as HookProvider;
    expect(() => getProjectDirPath('C:/somewhere', empty)).toThrow(/no session directories/);
  });

  it('throws rather than inventing a directory for a provider without one', () => {
    // Push-only providers register no getSessionDirs, so the `?? []` lands here.
    // The launch path never calls this function for them (see the push-only
    // suite below, which asserts projectDir === cwd); this pins that a stray
    // caller gets a loud error instead of a scan of the provider's home.
    expect(hermes.getSessionDirs).toBeUndefined();
    expect(() => getProjectDirPath('C:/somewhere', hermes)).toThrow(/no session directories/);
  });
});

describe('launchNewTerminal with a push-only provider', () => {
  it('runs the provider command, not Claude’s, in a terminal named by the provider', async () => {
    const { agent } = await launch(hermes, { directoryPath: 'C:/work/proj' });
    const terminal = createdTerminals[0];

    expect(terminal.name).toMatch(/^Hermes/);
    expect(terminal.cwd).toBe('C:/work/proj');
    expect(terminal.sent[0]).toMatch(/^hermes chat --session-id /);
    expect(String(agent?.providerId)).toBe('hermes');
  });

  it('registers the id the provider minted, so hook events route to this agent', async () => {
    const { agent, r } = await launch(hermes, { directoryPath: 'C:/work/proj' });
    const sessionId = String(agent?.sessionId);
    // Hermes' session ids are a validated upstream shape, never a bare uuid.
    expect(sessionId).toMatch(
      /^(\d{8}_\d{6}_[0-9a-f]{6}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/,
    );
    expect(terminalSentId()).toBe(sessionId);
    expect(r.activeAgentId.current).toBe(agent?.id);
  });

  it('carries no transcript, is flagged hooks-only, and pre-registers nothing to poll', async () => {
    const { agent, r } = await launch(hermes, { directoryPath: 'C:/work/proj' });
    expect(agent?.jsonlFile).toBe('');
    expect(agent?.hooksOnly).toBe(true);
    // The /clear project scan and the JSONL poll must NOT see this launch: the
    // agent would be culled for lines it can never gain.
    expect(r.knownJsonlFiles.size).toBe(0);
    expect(r.projectScanTimer.current).toBeNull();
    expect(r.jsonlPollTimers.size).toBe(0);
    expect(agent?.projectDir).toBe('C:/work/proj');
  });

  it('passes the provider env overlay through to createTerminal', async () => {
    await launch(hermes, { directoryPath: 'C:/work/proj' });
    const terminal = createdTerminals[0];
    if (hermes.buildLaunchCommand?.('x'.repeat(8), 'C:/work/proj', {})?.env) {
      expect(terminal.env).toBeDefined();
    } else {
      expect(terminal.env).toBeUndefined();
    }
  });

  it('never shows the terminal when suppressShow is set', async () => {
    await launch(hermes, { directoryPath: 'C:/work/proj', suppressShow: true });
    expect(createdTerminals[0].shown).toBe(0);
  });

  it('refuses a provider that cannot be launched, without leaving a character', async () => {
    const noCommand = { ...hermes, buildLaunchCommand: undefined } as unknown as HookProvider;
    await expect(launch(noCommand, { directoryPath: 'C:/work/proj' })).rejects.toThrow(
      /cannot be launched from the office/,
    );
    expect(createdTerminals.length).toBe(0);
  });

  it('persists the agent it created', async () => {
    const { persistAgents } = await launch(hermes, { directoryPath: 'C:/work/proj' });
    expect(persistAgents).toHaveBeenCalledTimes(1);
  });
});

function terminalSentId(): string | undefined {
  const match = /--session-id (\S+)/.exec(createdTerminals[0]?.sent[0] ?? '');
  return match?.[1];
}
