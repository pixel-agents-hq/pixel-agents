import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { DEFAULT_WORKSPACE_ID } from '../../core/src/constants.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { type ClientMessageContext, handleClientMessage } from '../src/clientMessageHandler.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { IPty, PtyModule } from '../src/terminal/ptyModule.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';
import { launchStandaloneAgent } from '../src/terminal/standaloneAgentLauncher.js';
import type { PersistedAgent } from '../src/types.js';
import { ensureWorkspacesFile, workspaceIdForDirectory } from '../src/workspaces.js';

class FakePty implements IPty {
  readonly pid = 4242;
  onData(): void {}
  onExit(): void {}
  write(): void {}
  resize(): void {}
  kill(): void {}
}

function fakePtyManager(): PtySessionManager {
  const module: PtyModule = { spawn: () => new FakePty() };
  return new PtySessionManager(() => ({ module, moduleId: 'fake-pty', reason: null }));
}

type Message = Record<string, unknown>;

/**
 * Workspaces end to end through the real handler, store, runtime and launcher,
 * with $HOME redirected to a fresh temp dir so nothing touches the real
 * ~/.pixel-agents.
 */
describe('workspaces', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let alpha: string;
  let beta: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let ptyManager: PtySessionManager;
  /** Everything fanned out to every office (store.broadcast). */
  let broadcasts: Message[];
  /** Point-to-point replies to the requesting client. */
  let sent: Message[];

  const workspacesFile = (): string => path.join(tempHome, '.pixel-agents', 'workspaces.json');
  const readWorkspacesFile = (): unknown => JSON.parse(fs.readFileSync(workspacesFile(), 'utf-8'));

  function ctx(overrides: Partial<ClientMessageContext> = {}): ClientMessageContext {
    return { store, runtime, cache: null, ptyManager, privileged: true, ...overrides };
  }

  function dispatch(msg: Message, context: ClientMessageContext = ctx()): void {
    handleClientMessage(msg, (m) => sent.push(m), context);
  }

  function lastWorkspacesLoaded(messages: Message[]): Message | undefined {
    return [...messages].reverse().find((m) => m.type === 'workspacesLoaded');
  }

  function saveWorkspace(name: string, directoryPaths: string[], id?: string): void {
    dispatch({ type: 'saveWorkspace', name, directoryPaths, ...(id ? { id } : {}) });
  }

  /** Id of the single non-default Workspace currently stored. */
  function onlyCustomId(): string {
    const loaded = lastWorkspacesLoaded(broadcasts)!.workspaces as Array<{ id: string }>;
    return loaded.find((w) => w.id !== DEFAULT_WORKSPACE_ID)!.id;
  }

  function launchInto(directoryPath?: string): number {
    const id = launchStandaloneAgent(
      {
        store,
        runtime,
        ptyManager,
        provider: { ...claudeProvider, getSessionDirs: () => [tempHome] },
      },
      { directoryPath },
    );
    expect(id).not.toBeNull();
    return id!;
  }

  function persistedAgent(overrides: Partial<PersistedAgent> = {}): PersistedAgent {
    const jsonlFile = path.join(tempHome, 'session.jsonl');
    fs.writeFileSync(jsonlFile, '');
    return {
      id: 9,
      sessionId: 'sess-9',
      terminalName: '',
      isExternal: true,
      jsonlFile,
      projectDir: tempHome,
      ...overrides,
    };
  }

  function restoreWith(records: PersistedAgent[]): void {
    const adapter: StateAdapter = {
      loadAgents: () => records,
      saveAgents: () => {},
      loadSeats: () => ({}),
      saveSeats: () => {},
      getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
      setSetting: vi.fn<(key: string, value: unknown) => void>(),
    };
    store.setAdapter(adapter);
    runtime.restoreExternalAgents();
  }

  beforeEach(() => {
    tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-workspaces-test-')));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    alpha = path.join(tempHome, 'alpha');
    beta = path.join(tempHome, 'beta');
    fs.mkdirSync(alpha);
    fs.mkdirSync(beta);

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    runtime = new AgentRuntime(store, claudeProvider);
    ptyManager = fakePtyManager();
    broadcasts = [];
    sent = [];
    store.on('broadcast', (m) => broadcasts.push(m));
  });

  afterEach(() => {
    runtime.dispose();
    store.dispose();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── acceptance 1, 2, 3 ───────────────────────────────────────

  describe('default Workspace and restore', () => {
    it('a fresh environment shows only the default Workspace and every agent in it (acceptance 1)', () => {
      store.set(
        1,
        createAgentState({
          id: 1,
          sessionId: 's',
          projectDir: '/p',
          jsonlFile: '/p/s.jsonl',
          isExternal: true,
        }),
      );

      dispatch({ type: 'webviewReady' });

      expect(lastWorkspacesLoaded(sent)).toEqual({
        type: 'workspacesLoaded',
        workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'Default', directoryPaths: [] }],
      });
      const existing = sent.find((m) => m.type === 'existingAgents')!;
      expect(existing.agents).toEqual([1]);
      expect(existing.workspaceIds).toEqual({});
      // Reading never writes: the file appears when the server starts or on a save.
      expect(fs.existsSync(workspacesFile())).toBe(false);
    });

    it('workspacesLoaded arrives after directoriesLoaded and before existingAgents', () => {
      dispatch({ type: 'webviewReady' });

      const types = sent.map((m) => m.type);
      expect(types.indexOf('workspacesLoaded')).toBeGreaterThan(types.indexOf('directoriesLoaded'));
      expect(types.indexOf('workspacesLoaded')).toBeLessThan(types.indexOf('existingAgents'));
    });

    it('ensureWorkspacesFile creates a file holding only the default Workspace, 0600 in a 0700 directory', () => {
      ensureWorkspacesFile();

      expect(readWorkspacesFile()).toEqual({
        workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'Default', directoryPaths: [] }],
      });
      expect(fs.statSync(workspacesFile()).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(workspacesFile())).mode & 0o777).toBe(0o700);
    });

    it('a legacy config.json beside no workspaces.json still restores agents into the default (acceptance 2)', () => {
      fs.mkdirSync(path.dirname(workspacesFile()), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.pixel-agents', 'config.json'),
        JSON.stringify({ standalone: { soundEnabled: false }, externalAssetDirectories: [] }),
      );

      restoreWith([persistedAgent()]);
      dispatch({ type: 'webviewReady' });

      expect(store.get(9)).toBeDefined();
      expect(store.get(9)?.workspaceId).toBeUndefined();
      expect(sent.find((m) => m.type === 'existingAgents')!.agents).toEqual([9]);
    });

    it('a persisted workspaceId naming no known Workspace restores into the default, not lost (acceptance 3)', () => {
      restoreWith([persistedAgent({ workspaceId: 'ghost-workspace' })]);

      expect(store.get(9)).toBeDefined();
      expect(store.get(9)?.workspaceId).toBeUndefined();
    });

    it('a persisted workspaceId naming a known Workspace is restored, persisted and announced', () => {
      saveWorkspace('Work', [alpha]);
      const workspaceId = onlyCustomId();

      restoreWith([persistedAgent({ workspaceId })]);

      expect(store.get(9)?.workspaceId).toBe(workspaceId);
      const saved: PersistedAgent[] = [];
      store.setAdapter({
        loadAgents: () => [],
        saveAgents: (agents) => saved.push(...agents),
        loadSeats: () => ({}),
        saveSeats: () => {},
        getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
        setSetting: () => {},
      });
      store.persist();
      expect(saved[0].workspaceId).toBe(workspaceId);

      sent = [];
      dispatch({ type: 'webviewReady' });
      expect(sent.find((m) => m.type === 'existingAgents')!.workspaceIds).toEqual({
        9: workspaceId,
      });
    });
  });

  // ── acceptance 4, 5, 15 ──────────────────────────────────────

  describe('saveWorkspace and launching', () => {
    it('creates a second Workspace, broadcasts it, and agents launched from its Directory join it (acceptance 4, 5)', () => {
      saveWorkspace('Work', [alpha]);

      expect(sent.filter((m) => m.type === 'workspaceRejected')).toEqual([]);
      const loaded = lastWorkspacesLoaded(broadcasts)!;
      expect(loaded.workspaces).toEqual([
        { id: DEFAULT_WORKSPACE_ID, name: 'Default', directoryPaths: [] },
        { id: expect.any(String), name: 'Work', directoryPaths: [alpha] },
      ]);
      const workspaceId = onlyCustomId();

      const created: Message[] = [];
      store.on('agentAdded', (id, agent) => created.push({ id, workspaceId: agent.workspaceId }));
      const inWork = launchInto(alpha);
      const inDefault = launchInto(beta);

      expect(store.get(inWork)?.workspaceId).toBe(workspaceId);
      expect(store.get(inDefault)?.workspaceId).toBeUndefined();
      // Born with the right Workspace: the agentAdded the wire message is built from already has it.
      expect(created[0]).toEqual({ id: inWork, workspaceId });
    });

    it('the Directory path is matched through the shared normalization, not by string equality', () => {
      saveWorkspace('Work', [alpha]);
      const workspaceId = onlyCustomId();

      expect(workspaceIdForDirectory(alpha + '/')).toBe(workspaceId);
      expect(workspaceIdForDirectory('~/alpha')).toBe(workspaceId);
    });

    it('launchAgent through the handler sets the Workspace of the Directory it names (acceptance 5)', () => {
      saveWorkspace('Work', [alpha]);
      const workspaceId = onlyCustomId();

      dispatch({ type: 'launchAgent', directoryPath: alpha });

      const agents = [...store.values()];
      expect(agents).toHaveLength(1);
      expect(agents[0].workspaceId).toBe(workspaceId);
    });

    it('a launch without a directoryPath, or with one no Workspace owns, joins the default without a rejection (acceptance 15)', () => {
      saveWorkspace('Work', [alpha]);
      sent = [];

      dispatch({ type: 'launchAgent' });
      dispatch({ type: 'launchAgent', directoryPath: path.join(tempHome, 'elsewhere') });

      const agents = [...store.values()];
      expect(agents).toHaveLength(2);
      expect(agents.map((a) => a.workspaceId)).toEqual([undefined, undefined]);
      expect(sent.filter((m) => m.type === 'workspaceRejected')).toEqual([]);
    });

    it('editing a Workspace by id renames it and replaces its Directories', () => {
      saveWorkspace('Work', [alpha]);
      const workspaceId = onlyCustomId();

      saveWorkspace('Work 2', [beta], workspaceId);

      expect(lastWorkspacesLoaded(broadcasts)!.workspaces).toContainEqual({
        id: workspaceId,
        name: 'Work 2',
        directoryPaths: [beta],
      });
      expect(workspaceIdForDirectory(alpha)).toBeUndefined();
      expect(workspaceIdForDirectory(beta)).toBe(workspaceId);
    });
  });

  // ── acceptance 8 (Directory part), 17 ────────────────────────

  describe('Directory ownership', () => {
    it('refuses a Directory already owned by another Workspace and changes nothing (acceptance 8)', () => {
      saveWorkspace('A', [alpha]);
      const before = fs.readFileSync(workspacesFile(), 'utf-8');
      broadcasts = [];

      saveWorkspace('B', [alpha + '/']);

      expect(sent).toContainEqual({
        type: 'workspaceRejected',
        reason: expect.stringContaining('A'),
      });
      expect(broadcasts.filter((m) => m.type === 'workspacesLoaded')).toEqual([]);
      expect(fs.readFileSync(workspacesFile(), 'utf-8')).toBe(before);
    });

    it('refuses a request listing the same Directory twice, spelled differently', () => {
      saveWorkspace('A', [alpha, alpha + '/']);

      expect(sent).toContainEqual(expect.objectContaining({ type: 'workspaceRejected' }));
      expect(fs.existsSync(workspacesFile())).toBe(false);
    });

    it('lets a Workspace keep its own Directories when it is saved again', () => {
      saveWorkspace('A', [alpha]);
      const workspaceId = onlyCustomId();

      saveWorkspace('A renamed', [alpha, beta], workspaceId);

      expect(sent.filter((m) => m.type === 'workspaceRejected')).toEqual([]);
      expect(workspaceIdForDirectory(beta)).toBe(workspaceId);
    });

    it('refuses to edit a Workspace that does not exist', () => {
      saveWorkspace('Ghost', [alpha], 'no-such-id');

      expect(sent).toContainEqual(expect.objectContaining({ type: 'workspaceRejected' }));
    });

    it('refuses to give the default Workspace Directories (it holds the unassigned ones itself)', () => {
      saveWorkspace('Default', [alpha], DEFAULT_WORKSPACE_ID);

      expect(sent).toContainEqual(expect.objectContaining({ type: 'workspaceRejected' }));
    });
  });

  describe('input validation and storage robustness (acceptance 17)', () => {
    it('writes workspaces.json 0600 in a 0700 directory, atomically with no tmp left behind', () => {
      saveWorkspace('Work', [alpha]);

      expect(fs.statSync(workspacesFile()).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(workspacesFile())).mode & 0o777).toBe(0o700);
      expect(
        fs.readdirSync(path.dirname(workspacesFile())).filter((f) => f.endsWith('.tmp')),
      ).toEqual([]);
    });

    it.each([
      ['non-array directoryPaths', { type: 'saveWorkspace', name: 'W', directoryPaths: 'nope' }],
      ['missing directoryPaths', { type: 'saveWorkspace', name: 'W' }],
      ['non-string name', { type: 'saveWorkspace', name: 7, directoryPaths: [] }],
      ['empty name', { type: 'saveWorkspace', name: '   ', directoryPaths: [] }],
      ['over-long name', { type: 'saveWorkspace', name: 'x'.repeat(500), directoryPaths: [] }],
      ['non-string path element', { type: 'saveWorkspace', name: 'W', directoryPaths: [alpha, 3] }],
      ['empty path element', { type: 'saveWorkspace', name: 'W', directoryPaths: [''] }],
      [
        'too many paths',
        {
          type: 'saveWorkspace',
          name: 'W',
          directoryPaths: Array.from({ length: 5000 }, (_, i) => `/p${i}`),
        },
      ],
      ['non-string id', { type: 'saveWorkspace', id: 5, name: 'W', directoryPaths: [] }],
      ['non-string removeWorkspace id', { type: 'removeWorkspace', id: 5 }],
      ['missing removeWorkspace id', { type: 'removeWorkspace' }],
    ])('replies workspaceRejected and leaves the file unchanged for %s', (_label, msg) => {
      saveWorkspace('Keep', [alpha]);
      const before = fs.readFileSync(workspacesFile(), 'utf-8');
      broadcasts = [];
      sent = [];

      dispatch(msg);

      expect(sent).toEqual([{ type: 'workspaceRejected', reason: expect.any(String) }]);
      expect(broadcasts.filter((m) => m.type === 'workspacesLoaded')).toEqual([]);
      expect(fs.readFileSync(workspacesFile(), 'utf-8')).toBe(before);
    });

    it('replies workspaceRejected when the write fails', () => {
      // A directory squatting on the target makes the final rename throw.
      fs.mkdirSync(workspacesFile(), { recursive: true });

      saveWorkspace('Work', [alpha]);

      expect(sent).toContainEqual({ type: 'workspaceRejected', reason: expect.any(String) });
      expect(broadcasts.filter((m) => m.type === 'workspacesLoaded')).toEqual([]);
      expect(
        fs.readdirSync(path.dirname(workspacesFile())).filter((f) => f.endsWith('.tmp')),
      ).toEqual([]);
    });

    describe.each([
      ['unparseable JSON', '{ not json'],
      ['wrong structure', JSON.stringify({ workspaces: 'nope' })],
      [
        'no default Workspace',
        JSON.stringify({ workspaces: [{ id: 'x', name: 'X', directoryPaths: [] }] }),
      ],
    ])('a workspaces.json that is %s', (_label, content) => {
      beforeEach(() => {
        fs.mkdirSync(path.dirname(workspacesFile()), { recursive: true });
        fs.writeFileSync(workspacesFile(), content);
      });

      it('is never overwritten; the server shows only the default and refuses writes', () => {
        ensureWorkspacesFile();
        dispatch({ type: 'webviewReady' });
        expect(lastWorkspacesLoaded(sent)).toEqual({
          type: 'workspacesLoaded',
          workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'Default', directoryPaths: [] }],
        });

        saveWorkspace('Work', [alpha]);
        dispatch({ type: 'removeWorkspace', id: 'x' });

        const rejections = sent.filter((m) => m.type === 'workspaceRejected');
        expect(rejections).toHaveLength(2);
        expect(fs.readFileSync(workspacesFile(), 'utf-8')).toBe(content);
      });

      it('does not make launches fail: agents join the default', () => {
        dispatch({ type: 'launchAgent', directoryPath: alpha });

        expect([...store.values()].map((a) => a.workspaceId)).toEqual([undefined]);
      });
    });
  });

  // ── acceptance 7, 9 ──────────────────────────────────────────

  describe('removeWorkspace', () => {
    it('cannot remove the default Workspace', () => {
      dispatch({ type: 'removeWorkspace', id: DEFAULT_WORKSPACE_ID });

      expect(sent).toContainEqual(expect.objectContaining({ type: 'workspaceRejected' }));
    });

    it('refuses an unknown id', () => {
      dispatch({ type: 'removeWorkspace', id: 'nope' });

      expect(sent).toContainEqual(expect.objectContaining({ type: 'workspaceRejected' }));
    });

    it('a delete by one office reaches every office; its agents fall back to the default and announce it (acceptance 9)', () => {
      const officeB: Message[] = [];
      store.on('broadcast', (m) => officeB.push(m));
      saveWorkspace('Work', [alpha]);
      const workspaceId = onlyCustomId();
      const lead = launchInto(alpha);
      const teammate = launchInto(alpha);
      const bystander = launchInto(beta);
      // A Teammate shares its Lead's Workspace; removal moves both, no special rule needed.
      store.get(teammate)!.leadAgentId = lead;
      broadcasts = [];
      officeB.length = 0;

      dispatch({ type: 'removeWorkspace', id: workspaceId });

      for (const office of [broadcasts, officeB]) {
        expect(lastWorkspacesLoaded(office)).toEqual({
          type: 'workspacesLoaded',
          workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'Default', directoryPaths: [] }],
        });
        const moves = office.filter((m) => m.type === 'agentWorkspaceChanged');
        expect(moves).toHaveLength(2);
        expect(moves).toEqual(
          expect.arrayContaining([
            { type: 'agentWorkspaceChanged', id: lead, workspaceId: DEFAULT_WORKSPACE_ID },
            { type: 'agentWorkspaceChanged', id: teammate, workspaceId: DEFAULT_WORKSPACE_ID },
          ]),
        );
      }
      expect(store.get(lead)?.workspaceId).toBeUndefined();
      expect(store.get(teammate)?.workspaceId).toBeUndefined();
      expect(store.get(bystander)?.workspaceId).toBeUndefined();
      // Its Directory is the default's again.
      expect(workspaceIdForDirectory(alpha)).toBeUndefined();
    });

    it('persists the moved agents so a restart does not resurrect the deleted Workspace id', () => {
      saveWorkspace('Work', [alpha]);
      const workspaceId = onlyCustomId();
      const agentId = launchInto(alpha);
      const saved: PersistedAgent[][] = [];
      store.setAdapter({
        loadAgents: () => [],
        saveAgents: (agents) => saved.push(agents),
        loadSeats: () => ({}),
        saveSeats: () => {},
        getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
        setSetting: () => {},
      });

      dispatch({ type: 'removeWorkspace', id: workspaceId });

      expect(store.get(agentId)).toBeDefined();
      expect(saved.at(-1)?.find((a) => a.id === agentId)?.workspaceId).toBeUndefined();
    });

    it('re-assigning a Directory leaves running agents where they were (acceptance 9)', () => {
      saveWorkspace('A', [alpha]);
      const workspaceA = onlyCustomId();
      const agentId = launchInto(alpha);
      saveWorkspace('B', []);
      const workspaceB = (
        lastWorkspacesLoaded(broadcasts)!.workspaces as Array<{ id: string; name: string }>
      ).find((w) => w.name === 'B')!.id;
      // Free alpha from A, then hand it to B.
      saveWorkspace('A', [], workspaceA);
      broadcasts = [];

      saveWorkspace('B', [alpha], workspaceB);

      expect(store.get(agentId)?.workspaceId).toBe(workspaceA);
      expect(broadcasts.filter((m) => m.type === 'agentWorkspaceChanged')).toEqual([]);
      expect(launchInto(alpha) && [...store.values()].at(-1)?.workspaceId).toBe(workspaceB);
    });
  });

  describe('read-only clients (acceptance 7)', () => {
    it('refuse saveWorkspace and removeWorkspace and re-send the real workspacesLoaded', () => {
      saveWorkspace('Work', [alpha]);
      const workspaceId = onlyCustomId();
      const before = fs.readFileSync(workspacesFile(), 'utf-8');
      broadcasts = [];
      sent = [];
      const readOnly = ctx({ privileged: false });

      dispatch({ type: 'saveWorkspace', name: 'Evil', directoryPaths: [beta] }, readOnly);
      dispatch({ type: 'removeWorkspace', id: workspaceId }, readOnly);

      expect(fs.readFileSync(workspacesFile(), 'utf-8')).toBe(before);
      expect(broadcasts).toEqual([]);
      const resent = sent.filter((m) => m.type === 'workspacesLoaded');
      expect(resent).toHaveLength(2);
      expect(resent[0]).toEqual({
        type: 'workspacesLoaded',
        workspaces: JSON.parse(before).workspaces,
      });
    });
  });
});
