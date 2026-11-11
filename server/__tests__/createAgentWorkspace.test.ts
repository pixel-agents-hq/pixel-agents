import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_WORKSPACE_ID } from '../../core/src/constants.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { listWorkspaces, saveWorkspace } from '../src/workspaces.js';
import { KbHarness } from './curatorHarness.js';

/**
 * createAgent 帶 workspaceId：自由路徑經驗證後建立（必要時）、加入該 Workspace、
 * 初始化 `<final>/.note/_default/`，再建立紀錄。任何拒絕或失敗都不留下東西。
 * 走真正的 handleClientMessage、store、runtime 與 workspaces.json（暫存 HOME）。
 */

const NOTE = '.note';
const PERSONAL_KEY = '_default';

/** 一個目錄底下所有項目（相對路徑，含 symlink 本身），用來確認「沒有建立任何東西」。 */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      out.push(path.relative(root, full));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out.sort();
}

describe('createAgent with workspaceId', () => {
  let h: KbHarness;
  let work: string;
  let ws: { id: string; dir: string };
  let outside: string;

  function create(directoryPath: unknown, extra: Record<string, unknown> = {}) {
    return h.send({ type: 'createAgent', directoryPath, workspaceId: ws.id, ...extra });
  }

  function directoryPathsOf(workspaceId: string): string[] {
    return listWorkspaces().find((w) => w.id === workspaceId)!.directoryPaths;
  }

  function workspacesLoadedBroadcasts(): Array<Array<{ id: string; directoryPaths: string[] }>> {
    return h.broadcasts
      .filter((m) => m.type === 'workspacesLoaded')
      .map((m) => m.workspaces as Array<{ id: string; directoryPaths: string[] }>);
  }

  function isRealDirectory(target: string): boolean {
    const stats = fs.lstatSync(target, { throwIfNoEntry: false });
    return stats !== undefined && stats.isDirectory() && !stats.isSymbolicLink();
  }

  beforeEach(() => {
    h = new KbHarness();
    work = path.join(h.tempHome, 'work');
    fs.mkdirSync(work);
    ws = h.workspace('alpha');
    // 讓 ~/.claude 存在：`~/.claude/x` 才會走到保護區規則，而不是「HOME 正下方不建立」。
    fs.mkdirSync(path.join(h.tempHome, '.claude'));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-outside-')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    h.dispose();
    fs.rmSync(outside, { recursive: true, force: true });
  });

  describe('refusals create nothing', () => {
    const cases: Array<{ label: string; path: () => unknown }> = [
      { label: 'a `..` segment', path: () => `${work}/../work/x` },
      { label: 'a `.` segment', path: () => `${work}/./x` },
      { label: 'a relative path', path: () => 'work/x' },
      { label: 'a `~/` path', path: () => '~/work/x' },
      { label: 'a doubled separator', path: () => `${work}//x` },
      { label: 'NUL', path: () => `${work}/a\0b` },
      { label: 'a newline', path: () => `${work}/a\nb` },
      { label: 'a C1 control character', path: () => `${work}/a\u0085b` },
      { label: 'a segment ending in a space', path: () => `${work}/a /b` },
      { label: 'a segment starting with a space', path: () => `${work}/ a` },
      { label: 'a segment over 255 bytes', path: () => `${work}/${'é'.repeat(130)}` },
      {
        label: 'a path over 4096 characters',
        path: () => `${work}/${Array.from({ length: 25 }, () => 'a'.repeat(200)).join('/')}`,
      },
      { label: 'more than 8 new segments', path: () => `${work}/1/2/3/4/5/6/7/8/9` },
      { label: '`/`', path: () => '/' },
      { label: 'HOME', path: () => h.tempHome },
      { label: 'a new directory directly in HOME', path: () => path.join(h.tempHome, 'fresh') },
      { label: '~/.claude', path: () => path.join(h.tempHome, '.claude') },
      { label: '~/.claude/x', path: () => path.join(h.tempHome, '.claude', 'x') },
      { label: '~/.pixel-agents/x', path: () => path.join(h.tempHome, '.pixel-agents', 'x') },
      { label: 'an ancestor of ~/.pixel-agents', path: () => path.dirname(h.tempHome) },
      { label: 'a `.note` segment', path: () => `${work}/${NOTE}/x` },
      { label: 'a `.NOTE` segment (case-insensitive)', path: () => `${work}/.NOTE/x` },
      { label: 'a nonexistent path outside HOME', path: () => path.join(outside, 'missing') },
      { label: 'a non-string path', path: () => 42 },
    ];

    it.each(cases)('$label', ({ label, path: input }) => {
      // `.NOTE` 只在不分大小寫的平台被拒。
      if (label.includes('.NOTE') && process.platform === 'linux') return;
      const homeBefore = tree(h.tempHome);
      const outsideBefore = tree(outside);
      const pathsBefore = directoryPathsOf(ws.id);
      h.broadcasts.length = 0;

      const replies = create(input());

      // 操作者要知道被拒絕：只回一則 workspaceRejected，理由是固定字串、不含輸入的路徑。
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ type: 'workspaceRejected' });
      expect(String(replies[0].reason)).toMatch(/^Couldn't create the Agent: /);
      if (typeof input() === 'string' && (input() as string).length > 1) {
        expect(String(replies[0].reason)).not.toContain(input() as string);
      }
      expect(h.store.size).toBe(0);
      expect(tree(h.tempHome)).toEqual(homeBefore);
      expect(tree(outside)).toEqual(outsideBefore);
      expect(directoryPathsOf(ws.id)).toEqual(pathsBefore);
      expect(workspacesLoadedBroadcasts()).toEqual([]);
    });

    it('refuses the default Workspace and an unknown Workspace', () => {
      const target = path.join(work, 'p');
      const before = tree(h.tempHome);

      const replies = [
        ...h.send({
          type: 'createAgent',
          directoryPath: target,
          workspaceId: DEFAULT_WORKSPACE_ID,
        }),
        ...h.send({ type: 'createAgent', directoryPath: target, workspaceId: 'no-such-workspace' }),
        ...h.send({ type: 'createAgent', directoryPath: target, workspaceId: 7 }),
      ];

      expect(replies.map((m) => m.type)).toEqual([
        'workspaceRejected',
        'workspaceRejected',
        'workspaceRejected',
      ]);
      expect(h.store.size).toBe(0);
      expect(tree(h.tempHome)).toEqual(before);
    });

    it('refuses a Workspace root and a path inside its KB folder', () => {
      const root = path.join(h.tempHome, 'kbroot');
      fs.mkdirSync(root);
      expect(h.send({ type: 'setWorkspaceRoot', workspaceId: ws.id, rootPath: root })).toEqual([]);
      const before = tree(h.tempHome);
      const pathsBefore = directoryPathsOf(ws.id);

      create(root);
      create(path.join(root, NOTE, 'x'));

      expect(h.store.size).toBe(0);
      expect(tree(h.tempHome)).toEqual(before);
      expect(directoryPathsOf(ws.id)).toEqual(pathsBefore);
    });

    it('refuses a pre-existing `.note` symlink and creates nothing under its target', () => {
      const target = path.join(h.tempHome, 'target');
      fs.mkdirSync(target);
      const p = path.join(work, 'p');
      fs.mkdirSync(p);
      fs.symlinkSync(target, path.join(p, NOTE));
      const before = tree(h.tempHome);

      create(p);

      expect(fs.readdirSync(target)).toEqual([]);
      expect(h.store.size).toBe(0);
      expect(tree(h.tempHome)).toEqual(before);
      expect(directoryPathsOf(ws.id)).not.toContain(p);
    });

    it('refuses a pre-existing `_default` symlink inside a real `.note`', () => {
      const target = path.join(h.tempHome, 'target');
      fs.mkdirSync(target);
      const p = path.join(work, 'p');
      fs.mkdirSync(path.join(p, NOTE), { recursive: true });
      fs.symlinkSync(target, path.join(p, NOTE, PERSONAL_KEY));

      create(p);

      expect(fs.readdirSync(target)).toEqual([]);
      expect(h.store.size).toBe(0);
      expect(directoryPathsOf(ws.id)).not.toContain(p);
    });

    it('refuses a Directory another Workspace registered through a symlink', () => {
      const p = path.join(work, 'shared');
      fs.mkdirSync(p);
      const link = path.join(h.tempHome, 'shared-link');
      fs.symlinkSync(p, link);
      expect(saveWorkspace({ name: 'beta', directoryPaths: [link] }).ok).toBe(true);
      const before = tree(h.tempHome);

      create(p);

      expect(h.store.size).toBe(0);
      expect(tree(h.tempHome)).toEqual(before);
      expect(directoryPathsOf(ws.id)).not.toContain(p);
    });

    it('refuses when another Workspace holds a Directory that cannot be resolved', () => {
      expect(
        saveWorkspace({ name: 'beta', directoryPaths: [path.join(h.tempHome, 'gone')] }).ok,
      ).toBe(true);
      const before = tree(h.tempHome);

      create(path.join(work, 'p'));

      expect(h.store.size).toBe(0);
      expect(tree(h.tempHome)).toEqual(before);
    });
  });

  describe('a failure after the first mkdir leaves nothing behind', () => {
    it('getSessionDirs returns nothing: no record, no new directories, the added entry is rolled back', () => {
      vi.spyOn(claudeProvider, 'getSessionDirs').mockReturnValue([]);
      const target = path.join(work, 'new', 'p');
      const before = tree(h.tempHome).filter((entry) => !entry.startsWith('.pixel-agents'));
      const pathsBefore = directoryPathsOf(ws.id);
      h.broadcasts.length = 0;

      create(target);

      expect(h.store.size).toBe(0);
      expect(fs.existsSync(path.join(work, 'new'))).toBe(false);
      expect(tree(h.tempHome).filter((entry) => !entry.startsWith('.pixel-agents'))).toEqual(
        before,
      );
      expect(directoryPathsOf(ws.id)).toEqual(pathsBefore);
      // 加入時廣播一次（含 P），回復時再廣播一次（不含 P）。
      const loaded = workspacesLoadedBroadcasts().map(
        (list) => list.find((w) => w.id === ws.id)!.directoryPaths,
      );
      expect(loaded).toEqual([[...pathsBefore, target], pathsBefore]);
    });

    it('getSessionDirs returns nothing for a Directory the Workspace already holds: the KB folder is removed, the list untouched', () => {
      vi.spyOn(claudeProvider, 'getSessionDirs').mockReturnValue([]);
      const pathsBefore = directoryPathsOf(ws.id);
      h.broadcasts.length = 0;

      create(ws.dir);

      expect(h.store.size).toBe(0);
      expect(fs.readdirSync(ws.dir)).toEqual([]);
      expect(directoryPathsOf(ws.id)).toEqual(pathsBefore);
      expect(workspacesLoadedBroadcasts()).toEqual([]);
    });

    it('stops cleaning at a directory that is no longer empty and leaves its contents', () => {
      const target = path.join(work, 'busy');
      vi.spyOn(claudeProvider, 'getSessionDirs').mockImplementation(() => {
        // 在紀錄建立前，有人往新目錄裡放了檔案。
        fs.writeFileSync(path.join(target, 'keep.txt'), 'x');
        return [];
      });

      create(target);

      expect(h.store.size).toBe(0);
      expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf-8')).toBe('x');
      expect(fs.existsSync(path.join(target, NOTE))).toBe(false);
      expect(directoryPathsOf(ws.id)).not.toContain(target);
    });
  });

  describe('success', () => {
    it('creates the Directory and its personal KB folder, adds it to the Workspace, and files the agent there', () => {
      expect(
        h.send({ type: 'setWorkspacePermissionRoles', workspaceId: ws.id, roles: ['R', 'E'] }),
      ).toEqual([]);
      const target = path.join(work, 'proj', 'app');
      h.broadcasts.length = 0;

      expect(create(target, { name: 'builder' })).toEqual([]);

      expect(isRealDirectory(target)).toBe(true);
      expect(isRealDirectory(path.join(target, NOTE, PERSONAL_KEY))).toBe(true);
      expect(fs.readdirSync(path.join(target, NOTE, PERSONAL_KEY))).toEqual([]);

      expect(h.store.size).toBe(1);
      const [[id, agent]] = [...h.store];
      expect(agent).toMatchObject({
        stopped: true,
        workspaceId: ws.id,
        launchDirectory: target,
        displayName: 'builder',
      });
      expect(directoryPathsOf(ws.id).filter((p) => p === target)).toHaveLength(1);
      const loaded = workspacesLoadedBroadcasts();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].find((w) => w.id === ws.id)!.directoryPaths).toContain(target);

      h.send({ type: 'startAgent', id });
      expect(h.spawned).toHaveLength(1);
      expect(h.spawned[0].options.cwd).toBe(target);
      expect(h.capabilities.validFor(id)?.workspaceId).toBe(ws.id);
      expect(h.store.get(id)!.permissionRoles).toEqual(['R', 'E']);
      expect(h.store.get(id)!.directoryRealPath).toBe(target);
    });

    it('stores the realpath, never the raw string (symlinked parent, trailing slash)', () => {
      const link = path.join(h.tempHome, 'work-link');
      fs.symlinkSync(work, link);

      create(`${path.join(link, 'via')}/`);

      const real = path.join(work, 'via');
      const [[, agent]] = [...h.store];
      expect(agent.launchDirectory).toBe(real);
      expect(agent.workspaceId).toBe(ws.id);
      expect(directoryPathsOf(ws.id)).toContain(real);
      expect(directoryPathsOf(ws.id)).not.toContain(path.join(link, 'via'));
      expect(isRealDirectory(path.join(real, NOTE, PERSONAL_KEY))).toBe(true);
    });

    it('a second agent in the same Directory succeeds and leaves the Directory list as it was', () => {
      const target = path.join(work, 'p');
      create(target);
      const after = directoryPathsOf(ws.id);

      create(target);

      expect(h.store.size).toBe(2);
      expect(directoryPathsOf(ws.id)).toEqual(after);
      for (const [, agent] of h.store) expect(agent.workspaceId).toBe(ws.id);
    });

    it('accepts the Workspace’s existing Directory without adding it again', () => {
      const pathsBefore = directoryPathsOf(ws.id);
      h.broadcasts.length = 0;

      create(ws.dir);

      expect(h.store.size).toBe(1);
      expect(directoryPathsOf(ws.id)).toEqual(pathsBefore);
      expect(workspacesLoadedBroadcasts()).toEqual([]);
      expect(isRealDirectory(path.join(ws.dir, NOTE, PERSONAL_KEY))).toBe(true);
    });

    it('accepts an existing directory outside HOME', () => {
      create(outside);

      const [[, agent]] = [...h.store];
      expect(agent.launchDirectory).toBe(outside);
      expect(agent.workspaceId).toBe(ws.id);
      expect(isRealDirectory(path.join(outside, NOTE, PERSONAL_KEY))).toBe(true);
    });

    it('start: true launches in the realpath', () => {
      const target = path.join(work, 'started');

      create(target, { start: true });

      expect(h.spawned).toHaveLength(1);
      expect(h.spawned[0].options.cwd).toBe(target);
    });

    it('persist and restore keep the Workspace', () => {
      const target = path.join(work, 'kept');
      create(target);
      const [[id]] = [...h.store];

      const restoredStore = new AgentStateStore();
      restoredStore.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
      const restoredRuntime = new AgentRuntime(restoredStore, claudeProvider);
      try {
        restoredRuntime.restoreExternalAgents();
        expect(restoredStore.get(id)).toMatchObject({
          stopped: true,
          workspaceId: ws.id,
          launchDirectory: target,
        });
      } finally {
        restoredRuntime.dispose();
        restoredStore.dispose();
      }
    });
  });

  describe('without workspaceId', () => {
    it('is unchanged: an existing Directory, no KB folder, no Workspace write', () => {
      const pathsBefore = directoryPathsOf(ws.id);
      h.broadcasts.length = 0;

      h.send({ type: 'createAgent', directoryPath: ws.dir });

      const [[, agent]] = [...h.store];
      expect(agent.workspaceId).toBe(ws.id);
      expect(agent.launchDirectory).toBe(ws.dir);
      expect(fs.readdirSync(ws.dir)).toEqual([]);
      expect(directoryPathsOf(ws.id)).toEqual(pathsBefore);
      expect(workspacesLoadedBroadcasts()).toEqual([]);
    });

    it('still refuses a missing path and creates nothing', () => {
      const before = tree(h.tempHome);

      h.send({ type: 'createAgent', directoryPath: path.join(work, 'missing') });

      expect(h.store.size).toBe(0);
      expect(tree(h.tempHome)).toEqual(before);
    });
  });
});
