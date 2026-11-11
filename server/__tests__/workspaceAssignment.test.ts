import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// fileWatcher.ts imports 'vscode' at module load; stub it (see fileWatcherDismissal.test.ts).
vi.mock('vscode', () => ({
  window: {
    activeTerminal: undefined,
    terminals: [],
  },
}));

import { DEFAULT_WORKSPACE_ID } from '../../core/src/constants.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import {
  readNewLines,
  scanExternalDir,
  scanForBackgroundAgentFiles,
  scanForTeammateFiles,
} from '../src/fileWatcher.js';
import { pathsMatch } from '../src/pathKey.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import type { AgentState, PersistedAgent } from '../src/types.js';
import { saveWorkspace, workspaceIdForCwd } from '../src/workspaces.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const SPAWN_TOOL_ID = 'toolu_workspace_spawn';

/**
 * Which Workspace an agent is filed under, end to end through the real runtime,
 * file scanner, hook handler and transcript parser, with $HOME redirected so
 * nothing touches the real ~/.pixel-agents or ~/.claude.
 */
describe('workspace assignment', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let dirA: string;
  let dirB: string;
  let workspaceA: string;
  let workspaceB: string;
  let projectDir: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  /** workspaceId each agent carried the moment its agentCreated was announced. */
  let created: Array<{ id: number; workspaceId: string | undefined }>;
  /** Every agentWorkspaceChanged broadcast. */
  let changes: Array<{ id: number; workspaceId: string }>;

  function createWorkspace(name: string, directoryPaths: string[]): string {
    const result = saveWorkspace({ name, directoryPaths });
    expect(result.ok).toBe(true);
    return result.id!;
  }

  function transcript(name: string, lines: string[] = []): string {
    const file = path.join(projectDir, name);
    fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
    return file;
  }

  function append(file: string, ...lines: string[]): void {
    fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(''));
  }

  const cwdRecord = (cwd: string): string =>
    JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } });
  const noCwdRecord = (): string =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });

  /** Make every file written so far an "ongoing session": adoption then skips to
   *  the end of the file, so only the head read can see an earlier cwd. */
  function ageFiles(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 30_000);
  }

  function scan(): void {
    scanExternalDir(
      projectDir,
      runtime.knownJsonlFiles,
      store.nextAgentId,
      store,
      runtime.fileWatchers,
      runtime.pollingTimers,
      runtime.waitingTimers,
      runtime.permissionTimers,
      () => {},
      { current: false },
    );
  }

  function agentFor(file: string): AgentState {
    const agent = [...store.values()].find((a) => pathsMatch(a.jsonlFile, file));
    expect(agent).toBeDefined();
    return agent!;
  }

  function readNew(agentId: number): void {
    readNewLines(agentId, store, runtime.waitingTimers, runtime.permissionTimers);
  }

  function sessionStart(sessionId: string, transcriptPath: string, cwd: string): void {
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd,
      source: 'startup',
    });
  }

  function confirm(sessionId: string): void {
    runtime.handleHookEvent('claude', { hook_event_name: 'Stop', session_id: sessionId });
  }

  function changesFor(id: number): Array<{ id: number; workspaceId: string }> {
    return changes.filter((c) => c.id === id);
  }

  beforeEach(() => {
    tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-ws-assign-')));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    dirA = path.join(tempHome, 'a', 'b');
    dirB = path.join(tempHome, 'beta');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB);
    projectDir = path.join(tempHome, 'projects', 'p');
    fs.mkdirSync(projectDir, { recursive: true });
    workspaceA = createWorkspace('A', [dirA]);
    workspaceB = createWorkspace('B', [dirB]);

    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;
    created = [];
    changes = [];
    store.on('agentAdded', (id, agent) => created.push({ id, workspaceId: agent.workspaceId }));
    store.on('broadcast', (m) => {
      if (m.type === 'agentWorkspaceChanged') {
        changes.push({ id: m.id as number, workspaceId: m.workspaceId as string });
      }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    runtime.dispose();
    store.dispose();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── workspaceIdForCwd ───────────────────────────────────────

  describe('workspaceIdForCwd', () => {
    it('matches the Directory itself and anything below it', () => {
      expect(workspaceIdForCwd(dirB)).toBe(workspaceB);
      expect(workspaceIdForCwd(path.join(dirB, 'src', 'deep'))).toBe(workspaceB);
    });

    it('compares on a path boundary: /a/b never matches /a/bc', () => {
      expect(workspaceIdForCwd(`${dirA}c`)).toBeUndefined();
      expect(workspaceIdForCwd(path.join(`${dirA}c`, 'x'))).toBeUndefined();
      expect(workspaceIdForCwd(path.join(dirA, 'x'))).toBe(workspaceA);
    });

    it('falls back to the default when nothing matches or there is no cwd', () => {
      expect(workspaceIdForCwd(path.join(tempHome, 'elsewhere'))).toBeUndefined();
      expect(workspaceIdForCwd(undefined)).toBeUndefined();
      expect(workspaceIdForCwd('')).toBeUndefined();
    });

    it('takes the longest prefix when Directories nest across Workspaces', () => {
      const nested = path.join(dirB, 'inner');
      const workspaceNested = createWorkspace('Nested', [nested]);

      expect(workspaceIdForCwd(path.join(nested, 'x'))).toBe(workspaceNested);
      expect(workspaceIdForCwd(path.join(dirB, 'other'))).toBe(workspaceB);
    });
  });

  // ── 8(a) to 8(f): external sessions, repeated for stability ──

  describe.each([1, 2, 3, 4, 5])('external session assignment (run %i)', () => {
    describe('8(a) hook path carries cwd', () => {
      it.each([
        { label: 'inside B', cwd: () => path.join(dirB, 'src'), expected: () => workspaceB },
        { label: 'inside A', cwd: () => dirA, expected: () => workspaceA },
        { label: 'a sibling /a/bc', cwd: () => `${dirA}c`, expected: () => undefined },
        { label: 'unrelated', cwd: () => path.join(tempHome, 'x'), expected: () => undefined },
      ])('files a hook-adopted session whose cwd is $label', ({ cwd, expected }) => {
        const file = transcript(`${UUID_A}.jsonl`);

        sessionStart(UUID_A, file, cwd());
        confirm(UUID_A);

        expect(created).toHaveLength(1);
        expect(created[0].workspaceId).toBe(expected());
        expect(changes).toEqual([]);
        expect(agentFor(file).workspaceCwdPending).toBeFalsy();
      });
    });

    describe('8(b) file scan reads the first cwd of the transcript', () => {
      it('files the agent under B from its first cwd, already in agentCreated', () => {
        const file = transcript(`${UUID_A}.jsonl`, [
          JSON.stringify({ type: 'file-history-snapshot' }),
          cwdRecord(path.join(dirB, 'src')),
        ]);
        ageFiles();

        scan();

        expect(created).toHaveLength(1);
        expect(created[0].workspaceId).toBe(workspaceB);
        expect(agentFor(file).workspaceCwdPending).toBeFalsy();
        expect(changes).toEqual([]);
      });

      it('files the agent under the default when the first cwd is outside every Workspace', () => {
        transcript(`${UUID_A}.jsonl`, [cwdRecord(path.join(tempHome, 'elsewhere'))]);
        ageFiles();

        scan();

        expect(created).toEqual([{ id: 1, workspaceId: undefined }]);
        expect(changes).toEqual([]);
      });

      it('files the agent under the default and leaves the cwd pending when none is readable', () => {
        const file = transcript(`${UUID_A}.jsonl`, [noCwdRecord()]);
        ageFiles();

        scan();

        expect(created).toEqual([{ id: 1, workspaceId: undefined }]);
        expect(agentFor(file).workspaceCwdPending).toBe(true);
      });

      it('ignores a half-written first line', () => {
        const file = path.join(projectDir, `${UUID_A}.jsonl`);
        fs.writeFileSync(file, `{"type":"user","cwd":"${dirB}`);
        ageFiles();

        scan();

        expect(created).toEqual([{ id: 1, workspaceId: undefined }]);
        expect(agentFor(file).workspaceCwdPending).toBe(true);
      });
    });

    describe('8(c) a settled agent ignores later cwd', () => {
      it('keeps B when SessionStart arrives with another cwd (known and auto-discovered)', () => {
        const file = transcript(`${UUID_A}.jsonl`, [cwdRecord(dirB)]);
        ageFiles();
        scan();
        const agent = agentFor(file);

        // auto-discovered branch: not yet registered with the router
        sessionStart(UUID_A, file, dirA);
        expect(agent.workspaceId).toBe(workspaceB);

        // known branch: registered by the auto-discovery above
        sessionStart(UUID_A, file, dirA);
        expect(agent.workspaceId).toBe(workspaceB);
        expect(changes).toEqual([]);
      });

      it('keeps the cwd of a later transcript record out of the assignment', () => {
        const file = transcript(`${UUID_A}.jsonl`, [cwdRecord(dirB)]);
        ageFiles();
        scan();
        const agent = agentFor(file);

        append(file, cwdRecord(dirA));
        readNew(agent.id);

        expect(agent.workspaceId).toBe(workspaceB);
        expect(changes).toEqual([]);
      });
    });

    describe('8(d) an empty transcript is filed when its cwd arrives in the transcript', () => {
      it.each([
        { label: 'empty', initial: [] as string[] },
        { label: 'cwd-less', initial: [noCwdRecord()] },
      ])('moves a $label adoption to B with exactly one agentWorkspaceChanged', ({ initial }) => {
        const file = transcript(`${UUID_A}.jsonl`, initial);
        ageFiles();
        scan();
        const agent = agentFor(file);
        expect(created).toEqual([{ id: agent.id, workspaceId: undefined }]);

        append(file, cwdRecord(path.join(dirB, 'src')));
        readNew(agent.id);

        expect(agent.workspaceId).toBe(workspaceB);
        expect(changes).toEqual([{ id: agent.id, workspaceId: workspaceB }]);
        expect(agent.workspaceCwdPending).toBeFalsy();

        // Settled: a later record elsewhere changes nothing.
        append(file, cwdRecord(dirA));
        readNew(agent.id);
        expect(changes).toHaveLength(1);
        expect(agent.workspaceId).toBe(workspaceB);
      });

      it('announces nothing when the arriving cwd belongs to the default', () => {
        const file = transcript(`${UUID_A}.jsonl`);
        ageFiles();
        scan();
        const agent = agentFor(file);

        append(file, cwdRecord(path.join(tempHome, 'elsewhere')));
        readNew(agent.id);

        expect(agent.workspaceId).toBeUndefined();
        expect(agent.workspaceCwdPending).toBeFalsy();
        expect(changes).toEqual([]);
      });
    });

    describe('8(e) an empty transcript is filed when SessionStart delivers the cwd', () => {
      it('known branch', () => {
        const file = transcript(`${UUID_A}.jsonl`);
        scan();
        const agent = agentFor(file);
        runtime.registerAgent(agent.sessionId, agent.id);

        sessionStart(UUID_A, file, path.join(dirB, 'src'));

        expect(agent.workspaceId).toBe(workspaceB);
        expect(changes).toEqual([{ id: agent.id, workspaceId: workspaceB }]);
        expect(agent.workspaceCwdPending).toBeFalsy();
      });

      it('auto-discovered branch', () => {
        const file = transcript(`${UUID_A}.jsonl`);
        scan();
        const agent = agentFor(file);

        sessionStart(UUID_A, file, path.join(dirB, 'src'));

        expect(agent.workspaceId).toBe(workspaceB);
        expect(changes).toEqual([{ id: agent.id, workspaceId: workspaceB }]);
      });

      it('SessionStart first (pending), scan adopts, confirmation arrives (adoptExternalSessionFromHook branch)', () => {
        const file = transcript(`${UUID_A}.jsonl`);
        sessionStart(UUID_A, file, path.join(dirB, 'src'));
        expect(created).toEqual([]);
        scan();
        const agent = agentFor(file);
        expect(created).toEqual([{ id: agent.id, workspaceId: undefined }]);

        confirm(UUID_A);

        expect(agent.workspaceId).toBe(workspaceB);
        expect(changes).toEqual([{ id: agent.id, workspaceId: workspaceB }]);
        expect(created).toHaveLength(1);
      });

      it('SessionStart first (pending) then confirmation adopts with the cwd already known', () => {
        const file = transcript(`${UUID_A}.jsonl`);
        sessionStart(UUID_A, file, path.join(dirB, 'src'));

        confirm(UUID_A);

        expect(created).toEqual([{ id: 1, workspaceId: workspaceB }]);
        expect(changes).toEqual([]);
      });

      it('agentRuntime teammate-tracked branch hands the cwd over too', () => {
        const file = transcript(`${UUID_A}.jsonl`, [
          JSON.stringify({
            type: 'user',
            teamName: 'team-x',
            agentName: 'worker',
            message: { role: 'user', content: 'hi' },
          }),
        ]);
        scan();
        const agent = agentFor(file);
        expect(agent.teamName).toBe('team-x');
        expect(agent.workspaceCwdPending).toBe(true);

        // A session id the agent does not carry, so the hook handler cannot match
        // it to the agent and parks it as pending; only the transcript path ties
        // the confirmation back to the already-tracked teammate.
        sessionStart(UUID_B, file, path.join(dirB, 'src'));
        confirm(UUID_B);

        expect(agent.workspaceId).toBe(workspaceB);
        expect(changes).toEqual([{ id: agent.id, workspaceId: workspaceB }]);
        expect(created).toHaveLength(1);
      });
    });

    describe('8(f) no cwd ever arrives', () => {
      it('keeps the default and announces nothing', () => {
        const file = transcript(`${UUID_A}.jsonl`);
        scan();
        const agent = agentFor(file);

        append(file, noCwdRecord());
        readNew(agent.id);
        sessionStart(UUID_A, file, '');

        expect(agent.workspaceId).toBeUndefined();
        expect(agent.workspaceCwdPending).toBe(true);
        expect(changes).toEqual([]);
      });
    });
  });

  it('does not settle a restarted server: the pending mark is neither persisted nor restored', () => {
    const persisted: unknown[] = [];
    store.setAdapter({
      loadAgents: () => [],
      saveAgents: (agents) => persisted.push(...agents),
      loadSeats: () => ({}),
      saveSeats: () => {},
      getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
      setSetting: () => {},
    });
    transcript(`${UUID_A}.jsonl`);
    scan();
    store.persist();

    expect(JSON.stringify(persisted)).not.toContain('workspaceCwdPending');
  });

  it("restore: a Teammate takes its Lead's Workspace again and an unknown Workspace id falls back to the default", () => {
    const files = [UUID_A, UUID_B, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'].map((uuid) =>
      transcript(`${uuid}.jsonl`),
    );
    const persistedAgent = (id: number, extra: Partial<PersistedAgent>): PersistedAgent => ({
      id,
      terminalName: '',
      sessionId: `restore-${id}`,
      isExternal: true,
      projectDir,
      jsonlFile: files[id - 1],
      ...extra,
    });
    let saved: Array<{ id: number; workspaceId?: string }> = [];
    store.setAdapter({
      loadAgents: () => [
        persistedAgent(1, { workspaceId: workspaceB, isTeamLead: true, teamName: 'crew' }),
        persistedAgent(2, {
          workspaceId: workspaceA,
          leadAgentId: 1,
          teamName: 'crew',
          agentName: 'w2',
        }),
        persistedAgent(3, { workspaceId: 'ws-that-was-deleted' }),
      ],
      saveAgents: (agents) => {
        saved = agents;
      },
      loadSeats: () => ({}),
      saveSeats: () => {},
      getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
      setSetting: () => {},
    });

    runtime.restoreExternalAgents();

    expect(store.get(1)!.workspaceId).toBe(workspaceB);
    expect(store.get(2)!.workspaceId).toBe(workspaceB);
    expect(store.get(3)!.workspaceId).toBeUndefined();
    expect(changes).toEqual([{ id: 2, workspaceId: workspaceB }]);
    expect(saved.map((a) => [a.id, a.workspaceId])).toEqual([
      [1, workspaceB],
      [2, workspaceB],
      [3, undefined],
    ]);
  });

  // ── 16: Teammates ───────────────────────────────────────────

  describe('Teammates follow their Lead', () => {
    const leadSession = 'lead-session';

    function addLead(workspaceId: string | undefined, extra: Partial<AgentState> = {}): AgentState {
      const lead = createAgentState({
        id: 1,
        sessionId: leadSession,
        isExternal: true,
        projectDir,
        jsonlFile: path.join(projectDir, `${leadSession}.jsonl`),
        workspaceId,
        ...extra,
      });
      store.set(1, lead);
      return lead;
    }

    function teammateOf(lead: AgentState): AgentState {
      const found = [...store.values()].find((a) => a.leadAgentId === lead.id);
      expect(found).toBeDefined();
      return found!;
    }

    function seedSidecar(opts: { name?: string; toolUseId?: string }): string {
      const dir = path.join(projectDir, leadSession, 'subagents');
      fs.mkdirSync(dir, { recursive: true });
      const jsonl = path.join(dir, 'agent-abc.jsonl');
      fs.writeFileSync(jsonl, '');
      fs.writeFileSync(
        path.join(dir, 'agent-abc.meta.json'),
        JSON.stringify({
          agentType: 'general-purpose',
          description: 'work',
          ...(opts.toolUseId ? { toolUseId: opts.toolUseId } : {}),
          ...(opts.name ? { name: opts.name } : {}),
        }),
      );
      return jsonl;
    }

    function runTeammateScan(lead: AgentState): void {
      scanForTeammateFiles(
        projectDir,
        leadSession,
        lead.id,
        store.nextAgentId,
        store,
        runtime.fileWatchers,
        runtime.pollingTimers,
        runtime.waitingTimers,
        runtime.permissionTimers,
        () => {},
      );
    }

    function removeWorkspaceB(): void {
      handleClientMessage({ type: 'removeWorkspace', id: workspaceB }, () => {}, {
        store,
        runtime,
        cache: null,
      });
    }

    function expectBackToDefaultOnce(ids: number[]): void {
      for (const id of ids) {
        expect(store.get(id)!.workspaceId).toBeUndefined();
        expect(changesFor(id)).toEqual([{ id, workspaceId: DEFAULT_WORKSPACE_ID }]);
      }
    }

    it('a sidecar-backed Teammate is created already in the Lead workspace, and leaves with it', () => {
      store.nextAgentId.current = 2;
      const lead = addLead(workspaceB, {
        backgroundAgentToolIds: new Set([SPAWN_TOOL_ID]),
      });
      seedSidecar({ name: 'scribe', toolUseId: SPAWN_TOOL_ID });

      scanForBackgroundAgentFiles(
        lead.id,
        store,
        store.nextAgentId,
        runtime.fileWatchers,
        runtime.pollingTimers,
        runtime.waitingTimers,
        runtime.permissionTimers,
        () => {},
      );

      const teammate = teammateOf(lead);
      expect(created.find((c) => c.id === teammate.id)!.workspaceId).toBe(workspaceB);

      removeWorkspaceB();
      expectBackToDefaultOnce([lead.id, teammate.id]);
    });

    it('an inline Teammate is created already in the Lead workspace, and leaves with it', () => {
      store.nextAgentId.current = 2;
      const lead = addLead(workspaceB);
      seedSidecar({});

      runTeammateScan(lead);

      const teammate = teammateOf(lead);
      expect(created.find((c) => c.id === teammate.id)!.workspaceId).toBe(workspaceB);

      removeWorkspaceB();
      expectBackToDefaultOnce([lead.id, teammate.id]);
    });

    it('an implicit-team Teammate is created already in the Lead workspace, and leaves with it', () => {
      store.nextAgentId.current = 2;
      const lead = addLead(workspaceB, { teamName: 'session-1234abcd' });
      transcript(`${UUID_B}.jsonl`, [
        JSON.stringify({
          type: 'user',
          teamName: 'session-1234abcd',
          agentName: 'scribe',
          message: { role: 'user', content: 'hi' },
        }),
      ]);

      runTeammateScan(lead);

      const teammate = teammateOf(lead);
      expect(teammate.agentName).toBe('scribe');
      expect(created.find((c) => c.id === teammate.id)!.workspaceId).toBe(workspaceB);

      removeWorkspaceB();
      expectBackToDefaultOnce([lead.id, teammate.id]);
    });

    describe('Teammate detected before its Lead', () => {
      const teamRecord = (extra: Record<string, unknown> = {}): string =>
        JSON.stringify({
          type: 'user',
          teamName: 'team-x',
          agentName: 'worker',
          message: { role: 'user', content: 'hi' },
          ...extra,
        });

      function addTeammate(workspaceId: string | undefined, pending = false): AgentState {
        const teammate = createAgentState({
          id: 2,
          sessionId: 'tm-session',
          isExternal: true,
          projectDir,
          jsonlFile: path.join(projectDir, 'tm.jsonl'),
          workspaceId,
          workspaceCwdPending: pending || undefined,
        });
        store.set(2, teammate);
        return teammate;
      }

      function feed(id: number, line: string): void {
        processTranscriptLine(id, line, store, runtime.waitingTimers, runtime.permissionTimers);
      }

      it('adopts the Lead workspace on linking, announcing the change once', () => {
        addLead(workspaceA, { teamName: 'team-x' });
        const teammate = addTeammate(workspaceB);

        feed(2, teamRecord());

        expect(teammate.leadAgentId).toBe(1);
        expect(teammate.workspaceId).toBe(workspaceA);
        expect(changes).toEqual([{ id: 2, workspaceId: workspaceA }]);
      });

      it('announces nothing when both already share a workspace', () => {
        addLead(workspaceB, { teamName: 'team-x' });
        const teammate = addTeammate(workspaceB);

        feed(2, teamRecord());

        expect(teammate.leadAgentId).toBe(1);
        expect(teammate.workspaceId).toBe(workspaceB);
        expect(changes).toEqual([]);
      });

      it('leaves an orphan Teammate where its own cwd put it', () => {
        const teammate = addTeammate(undefined, true);

        feed(2, teamRecord({ cwd: path.join(dirB, 'src') }));

        expect(teammate.leadAgentId).toBeUndefined();
        expect(teammate.workspaceId).toBe(workspaceB);
        expect(changes).toEqual([{ id: 2, workspaceId: workspaceB }]);
      });

      it('one record with team tags and a cwd follows the Lead and announces once', () => {
        addLead(workspaceA, { teamName: 'team-x' });
        const teammate = addTeammate(undefined, true);

        feed(2, teamRecord({ cwd: path.join(dirB, 'src') }));

        expect(teammate.leadAgentId).toBe(1);
        expect(teammate.workspaceId).toBe(workspaceA);
        expect(changes).toEqual([{ id: 2, workspaceId: workspaceA }]);
      });

      it('a cwd that arrives after the link is recorded, not applied', () => {
        addLead(workspaceA, { teamName: 'team-x' });
        const teammate = addTeammate(undefined, true);
        feed(2, teamRecord());
        expect(changes).toEqual([{ id: 2, workspaceId: workspaceA }]);

        feed(2, cwdRecord(path.join(dirB, 'src')));

        expect(teammate.workspaceId).toBe(workspaceA);
        expect(teammate.workspaceCwdPending).toBeFalsy();
        expect(changes).toHaveLength(1);
      });
    });

    it('a Lead filed by its cwd takes every Teammate along, one event each', () => {
      const lead = addLead(undefined, { workspaceCwdPending: true, teamName: 'team-x' });
      for (const id of [2, 3]) {
        store.set(
          id,
          createAgentState({
            id,
            sessionId: `tm-${id}`,
            isExternal: true,
            projectDir,
            jsonlFile: path.join(projectDir, `tm-${id}.jsonl`),
            leadAgentId: lead.id,
            agentName: `w${id}`,
          }),
        );
      }

      processTranscriptLine(
        1,
        cwdRecord(path.join(dirB, 'src')),
        store,
        runtime.waitingTimers,
        runtime.permissionTimers,
      );

      for (const id of [1, 2, 3]) {
        expect(store.get(id)!.workspaceId).toBe(workspaceB);
        expect(changesFor(id)).toEqual([{ id, workspaceId: workspaceB }]);
      }
    });
  });
});
