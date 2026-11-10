/**
 * P3 第二次獨立驗證 REFUTED 的重現指令與同類變體（P2-1 到 P2-7、P3、zsh）。
 * KB 類：伺服器以 KB 規則拒絕，且伺服器不可達時 hook 本地也 deny；F17 類：伺服器拒絕；
 * 角色類：role-delete／role-edit。真的 store、launcher（假 PTY）、curator 表與 WriteGuard。
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WRITE_GUARD_RULE_BASH_UNRESOLVED as UNRESOLVED,
  WRITE_GUARD_RULE_KB_PERSONAL as PERSONAL,
  WRITE_GUARD_RULE_KB_WORKSPACE as WORKSPACE,
  WRITE_GUARD_RULE_PROTECTED_CONFIG as CONFIG,
  WRITE_GUARD_RULE_ROLE_DELETE as ROLE_DELETE,
  WRITE_GUARD_RULE_ROLE_EDIT as ROLE_EDIT,
} from '../src/constants.js';
import { adversarialCases2 } from './bashAdversarialCases2.js';
import { BashGuardProbe } from './bashGuardProbe.js';
import { KbHarness } from './curatorHarness.js';

let h: KbHarness;
let probe: BashGuardProbe;
let ws: { id: string; dir: string };
let root: string;
let note: string;

beforeEach(() => {
  h = new KbHarness();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ws = h.workspace('alpha');
  root = path.join(h.tempHome, 'alpha-root');
  note = path.join(root, '.note');
  fs.mkdirSync(note, { recursive: true });
  fs.mkdirSync(path.join(h.tempHome, '.claude'), { recursive: true });
  probe = new BashGuardProbe(h);
});

afterEach(() => {
  probe.dispose();
  vi.restoreAllMocks();
  h.dispose();
});

const KB_RULES = [WORKSPACE, PERSONAL, UNRESOLVED];

function setupKb(rootPath = root): number {
  expect(h.send({ type: 'setWorkspaceRoot', workspaceId: ws.id, rootPath })).toEqual([]);
  const curator = probe.launch(ws.dir, ['R', 'E', 'D']);
  expect(h.send({ type: 'setWorkspaceCurator', workspaceId: ws.id, agentId: curator })).toEqual([]);
  return probe.launch(ws.dir, ['R', 'E', 'D']);
}

function misses(agent: number, commands: string[], rules: string[], cwd?: string, hook = true) {
  const missed: string[] = [];
  for (const command of commands) {
    const verdict = probe.bash(agent, command, cwd);
    const rule = verdict.verdict === 'deny' ? verdict.rule : 'allow';
    const fallback = hook ? probe.plan(agent, 'Bash', { command }, cwd).fallback.decision : 'deny';
    if (!rules.includes(rule) || fallback !== 'deny') {
      missed.push(`${command.slice(0, 120)} -> server=${rule} hook=${fallback}`);
    }
  }
  return missed;
}

const cases = () => adversarialCases2(root, note, h.tempHome);

describe('second verification: KB writes', () => {
  it('cwd = Agent Directory (P2-1, P2-3 ~N, P2-5, cwd in KB, zsh)', () => {
    const agent = setupKb();
    expect(misses(agent, cases().kb, KB_RULES)).toEqual([]);
  });

  it("cwd = Workspace root ($'...' P2-2, ~+ P2-3, lastpipe P3)", () => {
    const agent = setupKb();
    expect(misses(agent, cases().kbAtRoot, KB_RULES, root)).toEqual([]);
  });

  it('cwd = /tmp (~- P2-3, find -L/-H/-D/-O P2-6, ~user)', () => {
    const agent = setupKb();
    expect(misses(agent, cases().kbAtTmp, KB_RULES, '/tmp')).toEqual([]);
  });

  it('F17 through find -P and env -C<dir> (server side)', () => {
    const agent = setupKb();
    expect(misses(agent, cases().config, [CONFIG, UNRESOLVED], '/tmp', false)).toEqual([]);
  });
});

describe('second verification: role bypasses (including zsh)', () => {
  it('an agent without D cannot delete through any reproduction (zsh: =cmd, repeat, always, csh if, qualifiers and flags, also quoted)', () => {
    const agent = probe.launch(ws.dir, ['R', 'E']);
    const allowed = cases().role.filter((command) => {
      const verdict = probe.bash(agent, command);
      return !(verdict.verdict === 'deny' && verdict.rule === ROLE_DELETE);
    });
    expect(allowed).toEqual([]);
  });

  it('an R+E curator cannot delete the KB after (( << )) (F11 still holds)', () => {
    setupKb();
    const curator = h.curators.curatorOf(ws.id);
    expect(h.send({ type: 'unsetWorkspaceCurator', workspaceId: ws.id })).toEqual([]);
    void curator;
    const writer = probe.launch(ws.dir, ['R', 'E']);
    expect(h.send({ type: 'setWorkspaceCurator', workspaceId: ws.id, agentId: writer })).toEqual(
      [],
    );
    expect(probe.bash(writer, `(( x = 1 << 2 ))\nrm -rf ${note}/a.md`)).toMatchObject({
      rule: ROLE_DELETE,
    });
  });

  it('an R-only agent cannot hide an edit after (( << ))', () => {
    const agent = probe.launch(ws.dir, ['R']);
    for (const command of cases().readOnly) {
      expect(probe.bash(agent, command), command).toMatchObject({ rule: ROLE_EDIT });
    }
  });

  it.runIf(process.platform === 'darwin')('darwin: RM and /bin/Rm are rm (P2-7)', () => {
    const agent = probe.launch(ws.dir, ['R', 'E']);
    for (const command of ['RM -rf src', '/bin/Rm -rf src', 'Sudo RM -rf src']) {
      expect(probe.bash(agent, command), command).toMatchObject({ rule: ROLE_DELETE });
    }
  });
});

describe('second verification: things that must stay allowed', () => {
  it('a real heredoc is still data; [[ a > b ]] is a comparison; find -L outside the KB', () => {
    const agent = setupKb();
    const reader = probe.launch(ws.dir, ['R']);
    expect(probe.bash(reader, "cat <<'EOF'\nrm -rf src\nEOF")).toEqual({ verdict: 'allow' });
    expect(probe.bash(reader, '[[ a > b ]] && echo yes')).toEqual({ verdict: 'allow' });
    expect(probe.bash(agent, "find -L /tmp/zz-x -name '*.o' -delete", '/tmp')).toEqual({
      verdict: 'allow',
    });
    expect(probe.bash(reader, 'cat ~nobody/notes.txt')).toEqual({ verdict: 'allow' });
  });
});
