import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { PersistedAgent } from '../../core/src/schemas.js';
import { agentCreatedMessage } from '../src/agentMessages.js';
import { restoredAgentInit, toPersistedAgent } from '../src/agentPersistence.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { isCliWorktree, listCliWorktrees, removeCliWorktree } from '../src/cliWorktrees.js';
import { isTrackedProjectDir } from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { AgentState } from '../src/types.js';
import {
  familyHashes,
  invalidateAttributionDirectories,
  isTranscriptName,
  setAttributionDirectories,
} from '../src/worktreeAttribution.js';
import { create, excludeWorktreesFolder } from '../src/worktreeCreate.js';
import { worktreesMessage } from '../src/worktreeLeave.js';
import {
  resumeRetiringForTests,
  retireWhenUnused,
  stopRetiring,
  sweepWorktrees,
} from '../src/worktreeLeave.js';
import {
  isInWorktreesFolder,
  isWorktreeProjectDirOf,
  worktreeConventionOf,
  worktreeDirectoryOf,
  worktreeForProjectDir,
  worktreeLocationOf,
  worktreePathIn,
  worktreesExcludeLine,
} from '../src/worktreeLocation.js';
import { readRegistry } from '../src/worktreeRegistry.js';
import { gitIn, makeRepo, removeTempRepos } from './fixtures/gitRepos.js';
import { clearTestHome, removeTempDir } from './helpers/removeTempDir.js';

/**
 * Worktrees across reloads, reconnects and adoption: attribution goes by
 * location (any `<Directory>/.claude/worktrees/<name>` is the Directory's,
 * Claude's own worktrees included), the marker and branch survive a reload,
 * and the startup tidy-up and shutdown never take a Worktree from a live agent.
 */

function memoryAdapter(initial: PersistedAgent[] = []): StateAdapter {
  let current = initial;
  return {
    loadAgents: () => current,
    saveAgents: (agents) => {
      current = agents;
    },
    loadSeats: () => ({}),
    saveSeats: () => {},
    loadCardOrder: () => [],
    saveCardOrder: () => {},
    getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
    setSetting: () => {},
  };
}

/** Claude Code's own worktree (`claude -w foo`): made by git, not in our registry. */
function claudeWorktree(repo: string, name: string, branch: string): string {
  const folder = path.join(repo, '.claude', 'worktrees', name);
  gitIn(repo, 'worktree', 'add', '--quiet', '-b', branch, folder);
  return folder;
}

/** A transcript where Claude files a session run in `cwd`. */
function transcriptFor(cwd: string, sessionId: string): string {
  const dir = path.join(os.homedir(), '.claude', 'projects', normalizeProjectPath(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } })}\n`);
  return file;
}

describe("worktreeLocation, following the bundled provider's convention", () => {
  const directories = [
    { name: 'Repo', path: '/code/repo' },
    { name: 'Nested', path: '/code/repo/packages/app' },
  ];

  it('a folder under <Directory>/.claude/worktrees/<name> is that Directory’s worktree', () => {
    expect(worktreeLocationOf('/code/repo/.claude/worktrees/foo', directories)).toEqual({
      directory: directories[0],
      name: 'foo',
      path: path.resolve('/code/repo/.claude/worktrees/foo'),
    });
    expect(worktreeLocationOf('/code/repo/.claude/worktrees/foo/src', directories)?.name).toBe(
      'foo',
    );
    expect(
      worktreeLocationOf('/code/repo/packages/app/.claude/worktrees/bar', directories)?.directory
        .name,
    ).toBe('Nested');
  });

  it('the checkout itself, the worktrees folder alone, or elsewhere is no worktree', () => {
    expect(worktreeLocationOf('/code/repo', directories)).toBeNull();
    expect(worktreeLocationOf('/code/repo/src', directories)).toBeNull();
    expect(worktreeLocationOf('/code/repo/.claude/worktrees', directories)).toBeNull();
    expect(worktreeLocationOf('/elsewhere/.claude/worktrees/foo', directories)).toBeNull();
  });

  it('the family of project dirs: <hash>--claude-worktrees-<name>', () => {
    const hash = normalizeProjectPath('/code/repo');
    expect(normalizeProjectPath('/code/repo/.claude/worktrees/foo')).toBe(
      `${hash}--claude-worktrees-foo`,
    );
    expect(isWorktreeProjectDirOf(`${hash}--claude-worktrees-foo`, hash)).toBe(true);
    expect(isWorktreeProjectDirOf(hash, hash)).toBe(false);
    expect(isWorktreeProjectDirOf(`${hash}-src`, hash)).toBe(false);
  });

  it('the folder and the naming come from the first provider that declares them', () => {
    expect(worktreeConventionOf([])).toBeUndefined();
    expect(worktreeConventionOf([{}, claudeProvider])).toBe(claudeProvider.worktrees);
    // The office follows it: our Worktrees share the CLI's folder.
    expect(worktreePathIn('/code/repo', 'foo')).toBe(
      path.join('/code/repo', ...claudeProvider.worktrees!.folder, 'foo'),
    );
  });

  it('a project dir is read back to its folder by listing the worktrees folder', () => {
    const repo = makeRepo();
    claudeWorktree(repo, 'my_feature.2', 'feature');
    const projectDir = path.join(
      '/sessions',
      normalizeProjectPath(path.join(repo, '.claude', 'worktrees', 'my_feature.2')),
    );
    expect(worktreeForProjectDir(projectDir, [{ name: 'R', path: repo }])?.name).toBe(
      'my_feature.2',
    );
  });

  it('suggestions leave out anything at or below a worktree folder', () => {
    expect(isInWorktreesFolder('/code/repo/.claude/worktrees/foo')).toBe(true);
    expect(isInWorktreesFolder('/code/repo/.claude/worktrees/foo/pkg')).toBe(true);
    expect(isInWorktreesFolder('/code/repo/.claude')).toBe(false);
    expect(isInWorktreesFolder('/code/repo')).toBe(false);
  });

  it('builds a worktree folder and reads it back, strictly', () => {
    const folder = worktreePathIn('/code/repo', 'foo');
    expect(folder).toBe(path.join('/code/repo', '.claude', 'worktrees', 'foo'));
    expect(worktreeDirectoryOf(folder)).toEqual({
      directoryPath: path.resolve('/code/repo'),
      name: 'foo',
    });
    // Only the folder itself: not below it, not the worktrees folder, not elsewhere.
    expect(worktreeDirectoryOf(path.join(folder, 'src'))).toBeNull();
    expect(worktreeDirectoryOf('/code/repo/.claude/worktrees')).toBeNull();
    expect(worktreeDirectoryOf('/code/repo/worktrees/foo')).toBeNull();
    expect(worktreeDirectoryOf('/code/repo/other/worktrees/foo')).toBeNull();
    expect(worktreeDirectoryOf('/.claude/worktrees/..')).toBeNull();
  });

  it('a symlinked Directory matches a resolved cwd, and the path keeps its own spelling', () => {
    const repo = makeRepo();
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-link-')), 'repo');
    fs.symlinkSync(repo, link, 'dir');
    const directory = { name: 'R', path: link };

    const found = worktreeLocationOf(path.join(repo, '.claude', 'worktrees', 'x', 'src'), [
      directory,
    ]);
    expect(found).toEqual({ directory, name: 'x', path: worktreePathIn(link, 'x') });
    removeTempDir(path.dirname(link));
  });
});

/** Runs `run` as if no bundled provider declared a worktrees convention. */
async function withoutConvention(run: () => Promise<void> | void): Promise<void> {
  const provider = claudeProvider as { worktrees?: HookProvider['worktrees'] };
  const convention = provider.worktrees;
  delete provider.worktrees;
  try {
    await run();
  } finally {
    provider.worktrees = convention;
  }
}

describe('with no provider declaring a worktrees convention', () => {
  afterEach(() => removeTempRepos());

  it("our Worktrees go in the office's own folder, kept out of the repo's status", async () => {
    await withoutConvention(async () => {
      expect(worktreesExcludeLine()).toBe('/.pixel-agents/worktrees/');
      expect(worktreePathIn('/code/repo', 'foo')).toBe(
        path.join(path.resolve('/code/repo'), '.pixel-agents', 'worktrees', 'foo'),
      );
      const repo = makeRepo();
      expect(await excludeWorktreesFolder(repo)).toEqual({ ok: true });
      const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8');
      expect(exclude.split('\n')).toContain('/.pixel-agents/worktrees/');
    });
  });

  it('the CLI has no worktrees of its own: an unregistered one in that folder is none', async () => {
    const repo = makeRepo();
    const stray = path.join(repo, '.pixel-agents', 'worktrees', 'stray');
    gitIn(repo, 'worktree', 'add', '--quiet', '-b', 'stray', stray);
    await withoutConvention(async () => {
      expect(await listCliWorktrees(repo)).toEqual([]);
      expect(isCliWorktree(repo, 'stray')).toBe(false);
      expect(await removeCliWorktree(repo, 'stray', { inUse: () => false })).toEqual({
        ok: false,
        reason: 'There is no CLI worktree stray here.',
      });
    });
    expect(fs.existsSync(stray)).toBe(true);
  });

  it('a provider with no transcript pattern makes no file a transcript', () => {
    expect(isTranscriptName('notes.txt', [{}])).toBe(false);
    expect(isTranscriptName('a.jsonl', [{}])).toBe(false);
    expect(isTranscriptName('a.jsonl', [{}, claudeProvider])).toBe(true);
    expect(isTranscriptName('notes.txt', [claudeProvider])).toBe(false);
  });
});

describe('adopting sessions in a Directory’s worktrees', () => {
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let created: Array<Record<string, unknown>>;

  beforeEach(() => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    created = [];
    store.on('agentAdded', (id: number, agent: AgentState) =>
      created.push(agentCreatedMessage(id, agent)),
    );
  });

  afterEach(() => {
    runtime.dispose();
    setAttributionDirectories(() => []);
    removeTempRepos();
    clearTestHome('.claude');
  });

  it('a claude -w session (hooks) is adopted with Watch All off, named after the Directory, marked', () => {
    const repo = makeRepo();
    setAttributionDirectories(() => [{ name: 'Side Project', path: repo }]);
    const folder = claudeWorktree(repo, 'foo', 'feature/foo');
    const sessionId = crypto.randomUUID();
    const transcript = transcriptFor(folder, sessionId);
    expect(runtime.watchAllSessions.current).toBe(false);

    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      source: 'startup',
      cwd: folder,
      transcript_path: transcript,
    });
    // A session is adopted on its first event after SessionStart.
    runtime.handleHookEvent('claude', { hook_event_name: 'Stop', session_id: sessionId });

    expect(store.size).toBe(1);
    const agent = [...store.values()][0];
    expect(agent.directoryName).toBe('Side Project');
    expect(agent.worktree).toEqual({ name: 'foo', path: folder, branch: 'feature/foo' });
    expect(created[0]).toMatchObject({ worktree: { name: 'foo', branch: 'feature/foo' } });
    // Claude's worktree: shown, never managed.
    expect(readRegistry()).toEqual([]);
  });

  it('a session elsewhere (no Directory, Watch All off) is still not adopted', () => {
    const repo = makeRepo();
    setAttributionDirectories(() => [{ name: 'Side Project', path: repo }]);
    const stranger = makeRepo();
    const folder = claudeWorktree(stranger, 'foo', 'foo');
    const sessionId = crypto.randomUUID();
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      source: 'startup',
      cwd: folder,
      transcript_path: transcriptFor(folder, sessionId),
    });
    runtime.handleHookEvent('claude', { hook_event_name: 'Stop', session_id: sessionId });
    expect(store.size).toBe(0);
  });

  it('without hooks, the scanner finds the session in the family dir; older transcripts wait', async () => {
    const repo = makeRepo();
    setAttributionDirectories(() => [{ name: 'Side Project', path: repo }]);
    const folder = claudeWorktree(repo, 'bar', 'bar-branch');
    // A transcript from before the server started: the past, seeded as known.
    transcriptFor(folder, crypto.randomUUID());
    runtime.hooksEnabled.current = false;
    runtime.startExternalScanning(path.join(os.homedir(), '.claude', 'projects', 'none'));

    const fresh = transcriptFor(folder, crypto.randomUUID());
    await vi.waitFor(() => expect(store.size).toBe(1), { timeout: 8000, interval: 200 });

    const agent = [...store.values()][0];
    expect(agent.jsonlFile).toBe(fresh);
    expect(agent.directoryName).toBe('Side Project');
    expect(agent.worktree).toEqual({ name: 'bar', path: folder, branch: 'bar-branch' });
  }, 15_000);
});

describe('a Worktree agent across a reload', () => {
  afterEach(() => {
    resumeRetiringForTests();
    removeTempRepos();
    clearTestHome('.pixel-agents');
  });

  function worktreeAgent(id: number, jsonlFile: string): AgentState {
    return createAgentState({
      id,
      sessionId: `s-${id}`,
      isExternal: true,
      projectDir: path.dirname(jsonlFile),
      jsonlFile,
      directoryName: 'Side Project',
      worktree: {
        name: 'brave-otter',
        path: '/repo/.claude/worktrees/brave-otter',
        branch: 'feature/brave-otter',
      },
    });
  }

  it('is persisted with its Worktree and restored with its Directory name and branch', () => {
    const transcript = transcriptFor(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-wt-')), 's-7');
    const saved = toPersistedAgent(worktreeAgent(7, transcript))!;
    expect(saved.worktree).toEqual({
      name: 'brave-otter',
      path: '/repo/.claude/worktrees/brave-otter',
      branch: 'feature/brave-otter',
    });
    // A junk worktree field restores the agent without the marker.
    expect(
      restoredAgentInit({ ...saved, worktree: { name: 3 } as never }).worktree,
    ).toBeUndefined();

    const store = new AgentStateStore();
    store.setAdapter(memoryAdapter([JSON.parse(JSON.stringify(saved)) as PersistedAgent]));
    const runtime = new AgentRuntime(store, claudeProvider);
    try {
      const sent: Array<Record<string, unknown>> = [];
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), {
        store,
        runtime,
        cache: null,
        privileged: true,
      });
      const restored = store.get(7)!;
      expect(restored.directoryName).toBe('Side Project');
      expect(restored.worktree?.branch).toBe('feature/brave-otter');
      const existing = sent.find((m) => m.type === 'existingAgents');
      expect(existing?.worktrees).toEqual({
        7: { name: 'brave-otter', branch: 'feature/brave-otter' },
      });
    } finally {
      runtime.dispose();
    }
  });

  it('the sweep leaves a Worktree a saved external agent runs in (restored on connect) alone', async () => {
    const repo = makeRepo();
    const made = await create({ path: repo }, { pickName: () => 'held' });
    if (!made.ok) throw new Error(made.reason);
    const transcript = transcriptFor(made.worktree.path, 'held-session');
    const store = new AgentStateStore();
    store.setAdapter(
      memoryAdapter([
        {
          ...toPersistedAgent(worktreeAgent(3, transcript))!,
          worktree: { name: 'held', path: made.worktree.path, branch: made.worktree.branch },
        },
      ]),
    );

    await sweepWorktrees(store, { savedAgentsHold: (saved) => saved.isExternal === true });

    expect(fs.existsSync(path.join(made.worktree.path, 'README.md'))).toBe(true);
    expect(readRegistry()[0].state).toBe('active');
  });

  it('shutting down retires nothing: the next sweep does', async () => {
    const repo = makeRepo();
    const made = await create({ path: repo }, { pickName: () => 'cut-short' });
    if (!made.ok) throw new Error(made.reason);
    const store = new AgentStateStore();
    store.setAdapter(memoryAdapter());

    await stopRetiring(1000);
    await retireWhenUnused(store, made.worktree);
    expect(fs.existsSync(made.worktree.path)).toBe(true);
    expect(readRegistry()[0].state).toBe('active');

    resumeRetiringForTests();
    await sweepWorktrees(store, { savedAgentsHold: (saved) => saved.isExternal === true });
    expect(fs.existsSync(made.worktree.path)).toBe(false);
    expect(readRegistry()).toEqual([]);
  });
});

describe('reading the Directories for attribution', () => {
  it('a scan reads them once for every dir it asks about, and again only once they change', () => {
    let reads = 0;
    setAttributionDirectories(() => {
      reads++;
      return [{ name: 'R', path: '/code/repo' }];
    });
    const hashes = familyHashes([]);
    const family = `${normalizeProjectPath('/code/repo')}--claude-worktrees-x`;
    for (let i = 0; i < 50; i++) {
      expect(isTrackedProjectDir(`/projects/other-${i}`, hashes)).toBe(false);
    }
    expect(isTrackedProjectDir(`/projects/${family}`, hashes)).toBe(true);
    // The next scan reuses them...
    familyHashes([]);
    expect(reads).toBe(1);
    // ...until this process changes them.
    invalidateAttributionDirectories();
    familyHashes([]);
    expect(reads).toBe(2);
    setAttributionDirectories(() => []);
  });
});

describe('a Directory’s Worktrees on the wire', () => {
  it('are keyed by the Directory’s listed path, whichever spelling asks', async () => {
    const repo = makeRepo();
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-link-')), 'repo');
    fs.symlinkSync(repo, link, 'dir');
    // The office lists the Directory through the link; the registry records
    // the resolved root.
    setAttributionDirectories(() => [{ name: 'R', path: link }]);
    const made = await create({ path: repo }, { pickName: () => 'keyed' });
    if (!made.ok) throw new Error(made.reason);
    const store = new AgentStateStore();

    for (const asked of [readRegistry()[0].directoryPath, repo, link]) {
      expect((await worktreesMessage(store, asked)).directoryPath).toBe(link);
    }
    setAttributionDirectories(() => []);
    removeTempDir(path.dirname(link));
  });
});
