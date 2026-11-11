import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { createKbBrowseSlots, handleKbBrowseMessage } from '../src/kbBrowse.js';

/**
 * 讀取途中目錄被調換：readBoundedFile 讀完、回傳之前，執行 `duringRead`（把某一層
 * 換成另一個 inode 的同名目錄）。kbBrowse 讀完後重查整條目錄鏈，必須拒絕。
 * 以 vi.mock 包住真正的 readBoundedFile，時間點因此是確定的。
 */

const hooks = vi.hoisted(() => ({ duringRead: null as null | (() => void) }));

vi.mock('../src/kbFiles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/kbFiles.js')>();
  return {
    ...actual,
    readBoundedFile: async (filePath: string, maxBytes: number) => {
      const result = await actual.readBoundedFile(filePath, maxBytes);
      hooks.duringRead?.();
      return result;
    },
  };
});

let home: string;
let repo: string;
let store: AgentStateStore;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-kbswap-')));
  repo = path.join(home, 'repo');
  store = new AgentStateStore();
  store.set(
    1,
    createAgentState({
      id: 1,
      sessionId: 'session-1',
      projectDir: home,
      jsonlFile: path.join(home, '1.jsonl'),
      isExternal: false,
      directoryRealPath: repo,
    }),
  );
  const file = path.join(repo, '.note', '_default', 'sub', 'a.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'original');
});

afterEach(() => {
  hooks.duringRead = null;
  fs.rmSync(home, { recursive: true, force: true });
});

/** 把 `dir` 換成同名、內容相同的新目錄（不同 inode）。 */
function swapDirectory(dir: string): void {
  const moved = `${dir}.moved`;
  fs.renameSync(dir, moved);
  fs.cpSync(moved, dir, { recursive: true });
}

async function readA(): Promise<Array<Record<string, unknown>>> {
  const replies: Array<Record<string, unknown>> = [];
  await handleKbBrowseMessage(
    { type: 'readKbFile', target: { scope: 'agent', agentId: 1 }, relPath: 'sub/a.md' },
    { reply: (m) => replies.push(m), store, slots: createKbBrowseSlots() },
  );
  return replies;
}

describe('a directory swapped while a KB file is read', () => {
  it('reads normally when nothing changes', async () => {
    expect(await readA()).toMatchObject([{ type: 'kbFileRead', content: 'original' }]);
  });

  it.each([
    ['the key directory', () => path.join(repo, '.note', '_default')],
    ['.note', () => path.join(repo, '.note')],
    ['a middle directory', () => path.join(repo, '.note', '_default', 'sub')],
  ])('refuses when %s is swapped', async (_label, dirOf) => {
    hooks.duringRead = () => swapDirectory(dirOf());
    const replies = await readA();
    expect(replies).toEqual([
      {
        type: 'kbRejected',
        target: { scope: 'agent', agentId: 1 },
        relPath: 'sub/a.md',
        reason: 'unsafe',
      },
    ]);
  });

  it('refuses when the key directory is swapped for a symlink', async () => {
    hooks.duringRead = () => {
      const dir = path.join(repo, '.note', '_default');
      fs.renameSync(dir, `${dir}.moved`);
      fs.symlinkSync(`${dir}.moved`, dir);
    };
    expect((await readA())[0]).toMatchObject({ type: 'kbRejected', reason: 'unsafe' });
  });
});
