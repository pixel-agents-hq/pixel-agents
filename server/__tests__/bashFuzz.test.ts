/**
 * P3 驗證 F-1(3)：任意輸入下 analyzeBash 與伺服器端裁決永不拋出、也不會卡住。
 * 隨機組合括號、引號、反斜線、$( )、反引號、heredoc、case、function 等片段（固定種子，
 * 可重現）。內部例外會被 analyzeBash 吞掉並回 UNPARSEABLE_BASH；這裡另外斷言從未發生，
 * 也就是解析器本身沒有在任何輸入上丟例外。
 */

import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { analyzeBash, UNPARSEABLE_BASH } from '../src/writeGuard/bashAnalysis.js';
import { WriteGuard } from '../src/writeGuard/writeGuard.js';

const ATOMS = [
  '(',
  ')',
  '{ ',
  ' }',
  ' ',
  ';',
  '&&',
  '||',
  '|',
  '&',
  '$(',
  '`',
  "'",
  '"',
  '\\',
  '\n',
  '<<EOF\n',
  'EOF\n',
  "<<'Q'\n",
  'Q\n',
  'case ',
  ' in ',
  ' esac',
  ';;',
  ' a) ',
  '(a|b) ',
  'rm -rf ',
  'touch ',
  '/w/.note/x',
  '.note/k',
  '>',
  '>>',
  '2>&1',
  '&>',
  '<',
  '<<<',
  '<(',
  '$((',
  '))',
  '${',
  '}',
  'function f ',
  'f() ',
  'time -p ',
  'cd ',
  'cd - ',
  'popd ',
  '-o',
  'x',
  '*',
  '~',
  '$x',
  'env -S ',
  'if ',
  ' then ',
  ' fi',
  'for i in a; do ',
  ' done',
  '#',
  "$'\\x2e'",
  'git -C ',
  '--work-tree=',
  'sudo ',
  'xargs ',
  '=',
  'A=1 ',
];

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCommands(count: number, seed: number): string[] {
  const random = prng(seed);
  const out: string[] = [];
  for (let n = 0; n < count; n++) {
    const length = 1 + Math.floor(random() * 80);
    let s = '';
    for (let k = 0; k < length; k++) s += ATOMS[Math.floor(random() * ATOMS.length)];
    out.push(s);
  }
  return out;
}

const DEEP = [
  '('.repeat(5000) + 'rm x' + ')'.repeat(5000),
  '$('.repeat(5000) + 'rm x' + ')'.repeat(5000),
  '`'.repeat(5001),
  '"$('.repeat(3000),
  '{ '.repeat(5000) + 'rm x' + '; }'.repeat(5000),
  'case a in '.repeat(3000),
  '$(case a in a) '.repeat(2000),
  'function f { '.repeat(3000),
  "'".repeat(9999),
  '\\'.repeat(9999),
  '<<EOF\n'.repeat(3000),
  '${'.repeat(5000),
  '$(('.repeat(5000),
];

describe('fuzz: the Bash analysis never throws', () => {
  it('random fragment soups and pathological nesting', () => {
    const inputs = [...DEEP, ...randomCommands(3000, 20261109)];
    const failures: string[] = [];
    for (const input of inputs) {
      const result = analyzeBash(input);
      if (result === UNPARSEABLE_BASH) failures.push(input.slice(0, 80));
      expect(Array.isArray(result.ops) && Array.isArray(result.targets)).toBe(true);
    }
    expect(failures).toEqual([]);
  }, 60_000);

  it('the server verdict never throws on the same inputs', () => {
    const store = new AgentStateStore();
    const guard = new WriteGuard({
      store,
      ptyManager: { has: () => true },
      homeDir: () => '/home/u',
      workspaces: () => [{ id: 'default', name: 'Default', directoryPaths: [], rootPath: '/w' }],
    });
    store.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 's',
        projectDir: '/p',
        jsonlFile: path.join('/p', 's.jsonl'),
        isExternal: false,
        directoryRealPath: '/w/dir',
        permissionRoles: ['R', 'E'],
      }),
    );
    for (const command of [...DEEP, ...randomCommands(1000, 7)]) {
      const verdict = guard.verdict({
        tool_name: 'Bash',
        session_id: 's',
        cwd: '/w',
        paths: [],
        command,
      });
      expect(verdict?.verdict === 'allow' || verdict?.verdict === 'deny').toBe(true);
    }
    guard.dispose();
    store.dispose();
  }, 60_000);
});
