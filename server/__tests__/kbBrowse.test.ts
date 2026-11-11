import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { type ClientMessageContext, handleClientMessage } from '../src/clientMessageHandler.js';
import {
  KB_BROWSE_FILE_MAX_BYTES,
  KB_BROWSE_LIST_MAX_FILES,
  KB_BROWSE_MAX_DEPTH,
  KB_BROWSE_MAX_IN_FLIGHT,
} from '../src/constants.js';
import {
  createKbBrowseSlots,
  handleKbBrowseMessage,
  type KbBrowseSlots,
  parseKbRelPath,
} from '../src/kbBrowse.js';
import { saveWorkspace, setWorkspaceRoot } from '../src/workspaces.js';

/**
 * KB 唯讀瀏覽（listKbFiles／readKbFile）：真實檔案放在暫存 HOME 之下，Agent 直接放進
 * store（directoryRealPath 即啟動時記錄的 Directory realpath）。
 */

type Message = Record<string, unknown>;

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let home: string;
let originalHome: string | undefined;
let repo: string;
let store: AgentStateStore;

beforeEach(() => {
  originalHome = process.env.HOME;
  // realpath：macOS 的 tmpdir 本身就經過 symlink（/var -> /private/var）。
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-kbbrowse-')));
  process.env.HOME = home;
  repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  store = new AgentStateStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  // chmod 000 的目錄要先恢復才刪得掉。
  try {
    execFileSync('chmod', ['-R', 'u+rwx', home]);
  } catch {
    // 已不存在
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function addAgent(id: number, overrides: Record<string, unknown> = {}): void {
  store.set(
    id,
    createAgentState({
      id,
      sessionId: `session-${id}`,
      projectDir: home,
      jsonlFile: path.join(home, `${id}.jsonl`),
      isExternal: false,
      directoryRealPath: repo,
      ...overrides,
    }),
  );
}

function kbDir(key = '_default', base = repo): string {
  return path.join(base, '.note', key);
}

function writeFile(dir: string, rel: string, content: string | Buffer = 'hello'): string {
  const filePath = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** `slots: null` 代表這個連線沒有額度表（不能用 undefined：會套用預設值）。 */
async function call(msg: Message, slots: KbBrowseSlots | null = createKbBrowseSlots()) {
  const replies: Message[] = [];
  const result = handleKbBrowseMessage(msg, {
    reply: (m) => replies.push(m),
    store,
    slots: slots ?? undefined,
  });
  expect(result).not.toBe(false);
  await result;
  return replies;
}

const agentTarget = (agentId = 1) => ({ scope: 'agent', agentId });
const list = (...args: [target?: unknown]) =>
  call({ type: 'listKbFiles', target: args.length > 0 ? args[0] : agentTarget() });
const read = (relPath: unknown, ...args: [target?: unknown]) =>
  call({ type: 'readKbFile', target: args.length > 0 ? args[0] : agentTarget(), relPath });

async function single(promise: Promise<Message[]>): Promise<Message> {
  const replies = await promise;
  expect(replies).toHaveLength(1);
  return replies[0];
}

function workspaceWithRoot(root: string | null): string {
  const saved = saveWorkspace({ name: 'Docs', directoryPaths: [] });
  if (!saved.ok || !saved.id) throw new Error('not saved');
  if (root !== null) {
    expect(setWorkspaceRoot({ workspaceId: saved.id, rootPath: root }, [])).toEqual({ ok: true });
  }
  return saved.id;
}

describe('happy paths', () => {
  it('lists and reads an agent personal KB (reserved key without a Role)', async () => {
    addAgent(1);
    writeFile(kbDir(), 'notes.md', '# 筆記\n內容');
    writeFile(kbDir(), 'sub/deep/todo.txt', 'todo');
    writeFile(kbDir(), 'image.png', 'x');

    expect(await single(list())).toEqual({
      type: 'kbFilesListed',
      target: { scope: 'agent', agentId: 1 },
      files: [
        { path: 'notes.md', size: Buffer.byteLength('# 筆記\n內容') },
        { path: 'sub/deep/todo.txt', size: 4 },
      ],
      truncated: false,
    });
    expect(await single(read('sub/deep/todo.txt'))).toEqual({
      type: 'kbFileRead',
      target: { scope: 'agent', agentId: 1 },
      relPath: 'sub/deep/todo.txt',
      content: 'todo',
    });
  });

  it("uses the agent's Role id as its key", async () => {
    addAgent(1, { roleId: 'writer.md' });
    writeFile(kbDir('writer.md'), 'a.md', 'mine');
    writeFile(kbDir(), 'other.md', 'not mine');
    const listed = await single(list());
    expect(listed.files).toEqual([{ path: 'a.md', size: 4 }]);
    expect((await single(read('a.md'))).content).toBe('mine');
    expect((await single(read('other.md'))).reason).toBe('not_found');
  });

  it('lists and reads a Workspace KB, rereading the root on every request', async () => {
    const root = path.join(home, 'ws-root');
    writeFile(path.join(root, '.note'), 'guide.md', 'guide');
    const id = workspaceWithRoot(root);
    const target = { scope: 'workspace', workspaceId: id };

    expect(await single(list(target))).toEqual({
      type: 'kbFilesListed',
      target,
      files: [{ path: 'guide.md', size: 5 }],
      truncated: false,
    });
    expect((await single(read('guide.md', target))).content).toBe('guide');

    // 換根目錄之後立刻生效：沒有快取。
    const other = path.join(home, 'ws-other');
    writeFile(path.join(other, '.note'), 'new.md', 'new');
    expect(setWorkspaceRoot({ workspaceId: id, rootPath: other }, [])).toEqual({ ok: true });
    expect((await single(list(target))).files).toEqual([{ path: 'new.md', size: 3 }]);
  });
});

describe('the KB root chain', () => {
  it('refuses a symlinked key directory', async () => {
    addAgent(1);
    const elsewhere = path.join(home, 'elsewhere');
    writeFile(elsewhere, 'secret.md', 'secret');
    fs.mkdirSync(path.join(repo, '.note'));
    fs.symlinkSync(elsewhere, kbDir());
    expect((await single(list())).reason).toBe('unsafe');
    expect((await single(read('secret.md'))).reason).toBe('unsafe');
  });

  it('refuses a symlinked .note', async () => {
    addAgent(1);
    const elsewhere = path.join(home, 'elsewhere');
    writeFile(path.join(elsewhere, '_default'), 'secret.md', 'secret');
    fs.symlinkSync(elsewhere, path.join(repo, '.note'));
    expect((await single(list())).reason).toBe('unsafe');
    expect((await single(read('secret.md'))).reason).toBe('unsafe');
  });

  it('refuses a symlinked Workspace .note', async () => {
    const root = path.join(home, 'ws-root');
    fs.mkdirSync(root);
    const elsewhere = path.join(home, 'elsewhere');
    writeFile(elsewhere, 'secret.md', 'secret');
    fs.symlinkSync(elsewhere, path.join(root, '.note'));
    const target = { scope: 'workspace', workspaceId: workspaceWithRoot(root) };
    expect((await single(list(target))).reason).toBe('unsafe');
    expect((await single(read('secret.md', target))).reason).toBe('unsafe');
  });

  it('answers not_found for a missing KB and never creates a directory', async () => {
    addAgent(1);
    expect((await single(list())).reason).toBe('not_found');
    expect((await single(read('a.md'))).reason).toBe('not_found');
    expect(fs.existsSync(path.join(repo, '.note'))).toBe(false);
  });

  it('never falls back when the agent has no Directory realpath', async () => {
    addAgent(1, { directoryRealPath: undefined, directoryName: 'repo', projectDir: repo });
    writeFile(kbDir(), 'a.md');
    expect(await single(list())).toEqual({
      type: 'kbRejected',
      target: { scope: 'agent', agentId: 1 },
      reason: 'unavailable',
    });
    expect((await single(read('a.md'))).reason).toBe('unavailable');
  });

  it('refuses an agent whose Role id yields no key (never the reserved key)', async () => {
    addAgent(1, { roleId: '../escape.md' });
    writeFile(kbDir(), 'a.md', 'reserved');
    expect((await single(list())).reason).toBe('unavailable');
    expect((await single(read('a.md'))).reason).toBe('unavailable');
  });

  it('answers not_found for an unknown agent or Workspace', async () => {
    expect((await single(list(agentTarget(99)))).reason).toBe('not_found');
    expect(
      (await single(list({ scope: 'workspace', workspaceId: 'no-such-workspace' }))).reason,
    ).toBe('not_found');
  });

  it('answers unavailable for a Workspace without a root', async () => {
    const id = workspaceWithRoot(null);
    const target = { scope: 'workspace', workspaceId: id };
    expect((await single(list(target))).reason).toBe('unavailable');
    expect((await single(read('a.md', target))).reason).toBe('unavailable');
  });

  it('keeps an agent key inside its own directory (a.md vs a.md.md)', async () => {
    addAgent(1, { roleId: 'a.md' });
    writeFile(kbDir('a.md'), 'mine.md', 'mine');
    writeFile(kbDir('a.md.md'), 'secret.md', 'secret');
    expect((await single(list())).files).toEqual([{ path: 'mine.md', size: 4 }]);
    expect((await single(read('secret.md'))).reason).toBe('not_found');
    expect((await single(read('../a.md.md/secret.md'))).reason).toBe('unsafe');
  });
});

describe('entries inside the KB', () => {
  beforeEach(() => addAgent(1));

  it('skips a symlinked middle directory and refuses reads through it', async () => {
    const elsewhere = path.join(home, 'elsewhere');
    writeFile(elsewhere, 'secret.md', 'secret');
    writeFile(kbDir(), 'ok.md', 'ok');
    fs.symlinkSync(elsewhere, path.join(kbDir(), 'linked'));
    expect((await single(list())).files).toEqual([{ path: 'ok.md', size: 2 }]);
    expect((await single(read('linked/secret.md'))).reason).toBe('unsafe');
  });

  it('skips a symlinked file and refuses to read it', async () => {
    const secret = writeFile(path.join(home, 'elsewhere'), 'secret.md', 'secret');
    fs.mkdirSync(kbDir(), { recursive: true });
    fs.symlinkSync(secret, path.join(kbDir(), 'link.md'));
    expect((await single(list())).files).toEqual([]);
    expect((await single(read('link.md'))).reason).toBe('unsafe');
  });

  it('skips a hard-linked file and refuses to read it', async () => {
    const secret = writeFile(path.join(home, 'elsewhere'), 'secret.md', 'secret');
    fs.mkdirSync(kbDir(), { recursive: true });
    fs.linkSync(secret, path.join(kbDir(), 'hard.md'));
    expect((await single(list())).files).toEqual([]);
    expect((await single(read('hard.md'))).reason).toBe('unsafe');
  });

  it('skips a FIFO and refuses to read it without hanging', async () => {
    fs.mkdirSync(kbDir(), { recursive: true });
    execFileSync('mkfifo', [path.join(kbDir(), 'pipe.md')]);
    expect((await single(list())).files).toEqual([]);
    expect((await single(read('pipe.md'))).reason).toBe('unsafe');
  }, 3000);

  it('lists an oversized file but refuses to read it', async () => {
    writeFile(kbDir(), 'big.md', Buffer.alloc(KB_BROWSE_FILE_MAX_BYTES + 1, 0x61));
    writeFile(kbDir(), 'cap.md', Buffer.alloc(KB_BROWSE_FILE_MAX_BYTES, 0x61));
    expect((await single(list())).files).toEqual([
      { path: 'big.md', size: KB_BROWSE_FILE_MAX_BYTES + 1 },
      { path: 'cap.md', size: KB_BROWSE_FILE_MAX_BYTES },
    ]);
    expect((await single(read('big.md'))).reason).toBe('too_large');
    expect(((await single(read('cap.md'))).content as string).length).toBe(
      KB_BROWSE_FILE_MAX_BYTES,
    );
  });

  it('refuses a disallowed extension and content that is not safe text', async () => {
    writeFile(kbDir(), 'data.json', '{}');
    writeFile(kbDir(), 'bad.md', Buffer.from([0x61, 0xff, 0x62]));
    writeFile(kbDir(), 'bidi.md', 'a\u202eb');
    expect((await single(read('data.json'))).reason).toBe('not_text');
    expect((await single(read('bad.md'))).reason).toBe('not_text');
    expect((await single(read('bidi.md'))).reason).toBe('not_text');
  });

  it('leaves out dot-prefixed, control and bidi names, and refuses reading them', async () => {
    writeFile(kbDir(), 'ok.md');
    writeFile(kbDir(), '.hidden.md');
    writeFile(kbDir(), '.git/config.md');
    writeFile(kbDir(), 'a\u202eb.md');
    writeFile(kbDir(), 'line\nbreak.md');
    writeFile(kbDir(), 'zero\u200bwidth.md');
    expect((await single(list())).files).toEqual([{ path: 'ok.md', size: 5 }]);
    for (const name of ['.hidden.md', '.git/config.md', 'a\u202eb.md', 'line\nbreak.md']) {
      expect((await single(read(name))).reason, JSON.stringify(name)).toBe('unsafe');
    }
  });

  it('leaves out both names that differ only in letter case', async () => {
    writeFile(kbDir(), 'Note.md', 'upper');
    if (fs.existsSync(path.join(kbDir(), 'note.md'))) return; // 不分大小寫的磁碟：建不出兩個
    writeFile(kbDir(), 'note.md', 'lower');
    writeFile(kbDir(), 'other.md', 'x');
    expect((await single(list())).files).toEqual([{ path: 'other.md', size: 1 }]);
  });

  it('truncates the listing at the file cap', async () => {
    for (let i = 0; i <= KB_BROWSE_LIST_MAX_FILES; i++) {
      writeFile(kbDir(), `f${String(i).padStart(4, '0')}.md`, 'x');
    }
    const listed = await single(list());
    expect(listed.truncated).toBe(true);
    expect(listed.files).toHaveLength(KB_BROWSE_LIST_MAX_FILES);
  });

  it('truncates the listing at the depth cap', async () => {
    const segments = Array.from({ length: KB_BROWSE_MAX_DEPTH }, (_, i) => `d${i}`);
    writeFile(kbDir(), [...segments.slice(0, -1), 'deepest.md'].join('/'), 'ok');
    writeFile(kbDir(), [...segments, 'too-deep.md'].join('/'), 'no');
    const listed = await single(list());
    expect(listed.truncated).toBe(true);
    expect(listed.files).toEqual([
      { path: [...segments.slice(0, -1), 'deepest.md'].join('/'), size: 2 },
    ]);
  });
});

describe('request validation', () => {
  beforeEach(() => {
    addAgent(1);
    writeFile(kbDir(), 'a.md', 'a');
  });

  it.each([
    ['..'],
    ['../a.md'],
    ['sub/../a.md'],
    ['./a.md'],
    ['a//b.md'],
    ['/etc/passwd.md'],
    ['C:\\x.md'],
    ['C:/x.md'],
    ['\\\\server\\share\\x.md'],
    ['a\0.md'],
    ['sub\\a.md'],
    [''],
    [5],
    [null],
    [['a.md']],
    ['x'.repeat(1025)],
    [Array.from({ length: KB_BROWSE_MAX_DEPTH + 1 }, () => 'd').join('/') + '.md'],
  ])('refuses relPath %j as unsafe', async (relPath) => {
    const reply = await single(read(relPath));
    expect(reply).toMatchObject({ type: 'kbRejected', reason: 'unsafe' });
    expect(reply.content).toBeUndefined();
  });

  it('parses a valid relPath into segments', () => {
    expect(parseKbRelPath('sub/a.md')).toEqual(['sub', 'a.md']);
    expect(parseKbRelPath('sub/../a.md')).toBeNull();
  });

  it.each([
    [undefined],
    [null],
    ['agent'],
    [{ scope: 'agent' }],
    [{ scope: 'agent', agentId: 1.5 }],
    [{ scope: 'agent', agentId: '1' }],
    [{ scope: 'agent', agentId: 1, extra: true }],
    [{ scope: 'workspace', workspaceId: 7 }],
    [{ scope: 'workspace', workspaceId: '' }],
    [{ scope: 'other', id: 1 }],
  ])('refuses target %j without echoing it', async (target) => {
    expect(await single(list(target))).toEqual({ type: 'kbRejected', reason: 'not_found' });
  });

  it('echoes a fresh target object, never the client one', async () => {
    const reply = await single(read('a.md', { agentId: 1, scope: 'agent' }));
    expect(reply.target).toEqual({ scope: 'agent', agentId: 1 });
  });

  it('caps concurrent requests per connection', async () => {
    const slots = createKbBrowseSlots();
    slots.inFlight = KB_BROWSE_MAX_IN_FLIGHT;
    expect(
      await single(call({ type: 'readKbFile', target: agentTarget(), relPath: 'a.md' }, slots)),
    ).toEqual({
      type: 'kbRejected',
      target: { scope: 'agent', agentId: 1 },
      relPath: 'a.md',
      reason: 'unavailable',
    });
    expect(slots.inFlight).toBe(KB_BROWSE_MAX_IN_FLIGHT);

    // 並行送出 3 個：只有 2 個進得去，結束後額度歸零。
    const fresh = createKbBrowseSlots();
    const replies = await Promise.all(
      [1, 2, 3].map(() =>
        call({ type: 'readKbFile', target: agentTarget(), relPath: 'a.md' }, fresh),
      ),
    );
    const reasons = replies.flat().map((m) => (m.type === 'kbRejected' ? m.reason : m.type));
    expect(reasons.sort()).toEqual(['kbFileRead', 'kbFileRead', 'unavailable']);
    expect(fresh.inFlight).toBe(0);
  });

  it('refuses without a per-connection slot table (fail-closed)', async () => {
    expect((await single(call({ type: 'listKbFiles', target: agentTarget() }, null))).reason).toBe(
      'unavailable',
    );
  });

  it('refuses on a platform without O_NOFOLLOW guarantees', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect((await single(list())).reason).toBe('unavailable');
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

  it('ignores other message types', () => {
    expect(
      handleKbBrowseMessage(
        { type: 'requestRoles' },
        { reply: () => undefined, store, slots: undefined },
      ),
    ).toBe(false);
  });
});

describe('through handleClientMessage', () => {
  function ctx(overrides: Partial<ClientMessageContext> = {}): ClientMessageContext {
    return { store, cache: null, kbBrowse: createKbBrowseSlots(), ...overrides };
  }

  beforeEach(() => {
    addAgent(1);
    writeFile(kbDir(), 'a.md', 'secret content');
  });

  it('answers the requesting client point to point, never through a broadcast', async () => {
    const broadcasts: Message[] = [];
    store.on('broadcast', (m: Message) => broadcasts.push(m));
    const sent: Message[] = [];
    handleClientMessage(
      { type: 'readKbFile', target: agentTarget(), relPath: 'a.md' },
      (m) => sent.push(m),
      ctx(),
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ type: 'kbFileRead', content: 'secret content' });
    expect(broadcasts).toEqual([]);
  });
});

describe('logging', () => {
  it.skipIf(isRoot)('logs only an errno and ids, never a path or relPath', async () => {
    addAgent(1);
    writeFile(kbDir(), 'locked/secret-name.md', 'x');
    const logs: string[] = [];
    for (const method of ['error', 'warn', 'log'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(
          args
            .map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg)))
            .join(' '),
        );
      });
    }
    fs.chmodSync(path.join(kbDir(), 'locked'), 0o000);
    expect((await single(read('locked/secret-name.md'))).reason).toBe('unavailable');
    fs.chmodSync(kbDir(), 0o000);
    expect((await single(list())).reason).toBe('unavailable');

    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).toMatch(/^\[Pixel Agents\] KB: /);
      expect(line).toContain('(EACCES)');
      expect(line).toContain('[agent 1]');
      expect(line).not.toContain(home);
      expect(line).not.toContain('secret-name');
      expect(line).not.toContain('locked');
    }
  });
});
