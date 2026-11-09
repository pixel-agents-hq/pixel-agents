/**
 * P3 的 F13：Bash 與讀取類工具的伺服器端裁決（含伺服器自己的 Bash 解析、以 Agent
 * Directory 為起點的字面候選、權限角色）不做任何檔案系統呼叫。沿用 writeGuardServer
 * 的 module mock 計數作法。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsCounter = { on: false, calls: [] as string[] };
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const names = [
    'readFileSync',
    'writeFileSync',
    'realpathSync',
    'statSync',
    'lstatSync',
    'readlinkSync',
    'existsSync',
    'readdirSync',
    'openSync',
    'readSync',
    'accessSync',
  ] as const;
  const overrides = Object.fromEntries(
    names.map((name) => {
      const original = actual[name] as unknown as (...args: unknown[]) => unknown;
      return [
        name,
        (...args: unknown[]) => {
          if (fsCounter.on) fsCounter.calls.push(name);
          return original(...args);
        },
      ];
    }),
  );
  const realpathSync = Object.assign(overrides.realpathSync as typeof actual.realpathSync, {
    native: actual.realpathSync.native,
  });
  return {
    ...actual,
    ...overrides,
    realpathSync,
    default: { ...actual, ...overrides, realpathSync },
  };
});

const { AgentStateStore } = await import('../src/agentStateStore.js');
const { createAgentState } = await import('../src/agentState.js');
const { WriteGuard } = await import('../src/writeGuard/writeGuard.js');

let base: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-bash-f13-')));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('F13 for Bash and read tools', () => {
  it('decides Bash and Read requests from memory only', () => {
    const store = new AgentStateStore();
    const root = path.join(base, 'ws');
    const guard = new WriteGuard({
      store,
      ptyManager: { has: () => true },
      curators: { curatorOf: () => null },
      homeDir: () => base,
      workspaces: () => [{ id: 'default', name: 'Default', directoryPaths: [], rootPath: root }],
    });
    store.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 's1',
        projectDir: base,
        jsonlFile: path.join(base, 's1.jsonl'),
        isExternal: false,
        directoryRealPath: path.join(base, 'dir'),
        permissionRoles: ['R', 'E'],
      }),
    );
    fsCounter.calls = [];
    fsCounter.on = true;
    const verdicts = [
      guard.verdict({
        tool_name: 'Bash',
        session_id: 's1',
        cwd: base,
        paths: [path.join(root, '.note', 'a')],
        command: `cd sub && rm -rf ../.note && python -c "open('~/.claude/x')" > ${root}/.note/a`,
        recursive_paths: [path.join(base, 'dir', '.note')],
        mentioned_paths: [path.join(base, '.claude', 'x')],
      }),
      guard.verdict({ tool_name: 'Bash', session_id: 's1', cwd: base, paths: [], command: 'rm x' }),
      guard.verdict({ tool_name: 'Read', session_id: 's1', cwd: base, paths: [] }),
    ];
    fsCounter.on = false;
    expect(fsCounter.calls).toEqual([]);
    expect(verdicts.map((v) => v?.verdict)).toEqual(['deny', 'deny', 'allow']);
    guard.dispose();
    store.dispose();
  });
});
