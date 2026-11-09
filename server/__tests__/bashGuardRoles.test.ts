/**
 * P3 權限角色（R／E／D）的整合測試：真的 store、launcher（假 PTY）、curator 表與
 * WriteGuard；請求經過真的 hook 端欄位抽取與 Bash 解析。不呼叫真實 claude。
 * 驗收 1、5、6、12。
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WRITE_GUARD_BASH_MAX_PARSE_BYTES,
  WRITE_GUARD_DENY_TEMPLATES,
  WRITE_GUARD_RULE_BASH_UNRESOLVED,
  WRITE_GUARD_RULE_KB_WORKSPACE as KB_WORKSPACE,
  WRITE_GUARD_RULE_ROLE_DELETE as ROLE_DELETE,
  WRITE_GUARD_RULE_ROLE_EDIT as ROLE_EDIT,
  WRITE_GUARD_RULE_ROLE_READ as ROLE_READ,
} from '../src/constants.js';
import { BashGuardProbe } from './bashGuardProbe.js';
import { KbHarness } from './curatorHarness.js';

let h: KbHarness;
let probe: BashGuardProbe;
let ws: { id: string; dir: string };
let note: string;
const ALLOW = { verdict: 'allow' };

beforeEach(() => {
  h = new KbHarness();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ws = h.workspace('alpha');
  const root = path.join(h.tempHome, 'alpha-root');
  note = path.join(root, '.note');
  fs.mkdirSync(note, { recursive: true });
  probe = new BashGuardProbe(h);
});

afterEach(() => {
  probe.dispose();
  vi.restoreAllMocks();
  h.dispose();
});

const file = (name: string) => ({ file_path: path.join(ws.dir, name), content: 'x' });
const setRoot = () =>
  expect(
    h.send({ type: 'setWorkspaceRoot', workspaceId: ws.id, rootPath: path.dirname(note) }),
  ).toEqual([]);
const appoint = (agentId: number) =>
  expect(h.send({ type: 'setWorkspaceCurator', workspaceId: ws.id, agentId })).toEqual([]);

describe('roles are independent switches (acceptance 1)', () => {
  it('R only: Write, Edit, NotebookEdit and edit-class Bash are denied; Read, Glob, Grep, ls allowed', () => {
    const agent = probe.launch(ws.dir, ['R']);
    for (const tool of ['Write', 'Edit']) {
      expect(probe.ask(agent, tool, file('a.ts'))).toMatchObject({ rule: ROLE_EDIT });
    }
    expect(
      probe.ask(agent, 'NotebookEdit', { notebook_path: path.join(ws.dir, 'n.ipynb') }),
    ).toMatchObject({ rule: ROLE_EDIT });
    for (const tool of ['Read', 'Glob', 'Grep']) {
      expect(probe.ask(agent, tool, { file_path: path.join(ws.dir, 'a.ts') })).toEqual(ALLOW);
    }
    expect(probe.bash(agent, 'ls -la && cat a.ts | grep x')).toEqual(ALLOW);
    expect(probe.bash(agent, 'npm test')).toMatchObject({ rule: ROLE_EDIT });
    expect(probe.bash(agent, 'echo x > out.txt')).toMatchObject({ rule: ROLE_EDIT });
  });

  it('E only: cannot rm, can run npm test and write files', () => {
    const agent = probe.launch(ws.dir, ['E']);
    expect(probe.bash(agent, 'rm -f a.ts')).toMatchObject({ rule: ROLE_DELETE });
    expect(probe.bash(agent, 'npm test')).toEqual(ALLOW);
    expect(probe.bash(agent, 'touch a.ts && sed -i s/a/b/ a.ts')).toEqual(ALLOW);
    expect(probe.ask(agent, 'Write', file('a.ts'))).toEqual(ALLOW);
    expect(probe.ask(agent, 'Edit', file('a.ts'))).toEqual(ALLOW);
  });

  it('without R every read tool and read-class command is denied (read needs R)', () => {
    const agent = probe.launch(ws.dir, ['E', 'D']);
    for (const tool of ['Read', 'Glob', 'Grep']) {
      expect(probe.ask(agent, tool, {})).toMatchObject({ verdict: 'deny', rule: ROLE_READ });
    }
    expect(probe.bash(agent, 'cat a.ts')).toMatchObject({ rule: ROLE_READ });
  });

  it('D allows rm; R+E cannot rm (also not through sudo, a substitution or find -delete)', () => {
    const remover = probe.launch(ws.dir, ['D']);
    expect(probe.bash(remover, 'rm -rf build')).toEqual(ALLOW);
    const editor = probe.launch(ws.dir, ['R', 'E']);
    for (const command of [
      'rm -rf build',
      'sudo rm x',
      'echo $(rm x)',
      'find . -name "*.tmp" -delete',
      'git clean -fd',
      'ls; rmdir d',
    ]) {
      expect(probe.bash(editor, command)).toMatchObject({ rule: ROLE_DELETE });
    }
    expect(probe.bash(editor, 'npm test && git add . && git commit -m wip')).toEqual(ALLOW);
  });

  it('an empty role set turns every switch off; tools outside the roles are not judged', () => {
    const agent = probe.launch(ws.dir, []);
    expect(probe.ask(agent, 'Read', {})).toMatchObject({ rule: ROLE_READ });
    expect(probe.ask(agent, 'Write', file('a.ts'))).toMatchObject({ rule: ROLE_EDIT });
    expect(probe.bash(agent, 'rm a')).toMatchObject({ rule: ROLE_DELETE });
    expect(() => probe.ask(agent, 'WebFetch', { url: 'https://example.com' })).toThrow('no plan');
  });
});

describe('no roles = everything allowed, exactly as before (acceptance 6)', () => {
  it('a launch without roles has no role checks at all; only KB/F17 rules remain', () => {
    setRoot();
    const agent = probe.launch(ws.dir);
    expect(h.store.get(agent)?.permissionRoles).toBeNull();
    for (const command of ['npm test', 'rm -rf build', 'cat a', 'python x.py', 'git add .']) {
      expect(probe.bash(agent, command)).toEqual(ALLOW);
    }
    for (const tool of ['Read', 'Write', 'Edit']) {
      expect(probe.ask(agent, tool, file('a.ts'))).toEqual(ALLOW);
    }
    // KB 規則照樣生效（不論有無角色）：寫工作空間 KB；`git clean` 不帶路徑會清掉整個
    // Agent Directory（含其個人 KB 區的其他識別鍵），遞迴命中。
    expect(probe.bash(agent, `echo x > ${path.join(note, 'a.md')}`)).toMatchObject({
      rule: 'kb-workspace-no-writer',
    });
    expect(probe.bash(agent, 'git clean -fd')).toMatchObject({ rule: 'kb-personal' });
  });
});

describe('the KB exception never widens the roles (acceptance 5, F11)', () => {
  it('an R-only curator is still denied writing the Workspace .note/; an R+E curator is allowed', () => {
    setRoot();
    const readOnly = probe.launch(ws.dir, ['R']);
    appoint(readOnly);
    const target = path.join(note, 'a.md');
    expect(probe.ask(readOnly, 'Write', { file_path: target })).toMatchObject({ rule: ROLE_EDIT });
    expect(probe.bash(readOnly, `echo x > ${target}`)).toMatchObject({ rule: ROLE_EDIT });
    expect(probe.bash(readOnly, `tee ${target} < /dev/null`)).toMatchObject({ rule: ROLE_EDIT });
    expect(probe.bash(readOnly, `cat ${target}`)).toEqual(ALLOW);

    expect(h.send({ type: 'unsetWorkspaceCurator', workspaceId: ws.id })).toEqual([]);
    const writer = probe.launch(ws.dir, ['R', 'E']);
    appoint(writer);
    expect(probe.ask(writer, 'Write', { file_path: target })).toEqual(ALLOW);
    expect(probe.bash(writer, `echo x > ${target}`)).toEqual(ALLOW);
    // 非 curator 的 R+E 仍被 KB 規則擋下（KB deny 先於角色）。
    const other = probe.launch(ws.dir, ['R', 'E', 'D']);
    expect(probe.bash(other, `echo x > ${target}`)).toMatchObject({ rule: KB_WORKSPACE });
  });
});

describe('long commands keep the role check (F9)', () => {
  it('a request too large to send still carries the hook-side classes: padding cannot hide rm', () => {
    const agent = probe.launch(ws.dir, ['R', 'E']);
    const padded = `rm -rf build # ${'a'.repeat(70_000)}`;
    const body = JSON.parse(probe.plan(agent, 'Bash', { command: padded }).body);
    expect(body.command).toBeUndefined();
    expect(probe.bash(agent, padded)).toMatchObject({ rule: ROLE_DELETE });
    expect(probe.bash(probe.launch(ws.dir, ['R', 'E', 'D']), padded)).toEqual(ALLOW);
  });

  // 第二次驗證後修改（使用者決定的語意變更，P4）：超過 1 MiB 原本只需要 E，R+E 可以用填充
  // 夾帶 rm；現在與巢狀超限相同，需要 E 與 D。R-only 仍是 role-edit、KB 啟用時仍是
  // kb-bash-unresolved；唯一改變的是 R+E 由放行變成 role-delete（只有更嚴，沒有弱化）。
  it('a command over the parse limit needs E and D (like nesting overflow) and, with KB rules on, is denied', () => {
    const huge = `echo ${'a'.repeat(WRITE_GUARD_BASH_MAX_PARSE_BYTES)}`;
    expect(probe.bash(probe.launch(ws.dir, ['R']), huge)).toMatchObject({ rule: ROLE_EDIT });
    expect(probe.bash(probe.launch(ws.dir, ['R', 'E']), huge)).toMatchObject({ rule: ROLE_DELETE });
    expect(probe.bash(probe.launch(ws.dir, ['R', 'E', 'D']), huge)).toEqual(ALLOW);
    setRoot();
    expect(probe.bash(probe.launch(ws.dir, ['R', 'E']), huge)).toMatchObject({
      rule: WRITE_GUARD_RULE_BASH_UNRESOLVED,
    });
  });
});

describe('deny messages (acceptance 12, F16)', () => {
  it('use the fixed role template and the command name only, never the whole command', async () => {
    const agent = probe.launch(ws.dir, ['R', 'E']);
    const reason = await probe.reason(agent, 'ls && rm -rf secret-dir # SECRET_TOKEN_123');
    const template = WRITE_GUARD_DENY_TEMPLATES[ROLE_DELETE];
    expect(reason).toBe(
      `Reason: ${template.reason} Command: "rm".\nWhy: ${template.rationale}\n` +
        `Suggestion: ${template.suggestion}`,
    );
    expect(reason).not.toContain('SECRET');
    expect(reason).not.toContain('secret-dir');
  });

  it('strips control characters from the command fragment and clips it', async () => {
    const agent = probe.launch(ws.dir, ['R']);
    const name = `x\u001b[31m${'y'.repeat(200)}`;
    const reason = await probe.reason(agent, `'${name}' arg`);
    expect(reason).not.toContain('\u001b');
    expect(reason).toContain('Command: "x[31myyyy');
    expect(reason).toContain('..."');
    expect(reason?.length).toBeLessThan(900);
  });
});
