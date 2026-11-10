/**
 * P3 獨立驗證 REFUTED（第 1 輪）的重現指令（F-1 到 F-8）與同類變體。
 * 每條斷言伺服器以 KB 規則或角色規則拒絕；KB 案例另外斷言伺服器不可達時 hook 本地
 * 也 fail-closed。真的 store、launcher（假 PTY）、curator 表與 WriteGuard。
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
import { adversarialCases } from './bashAdversarialCases.js';
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
  probe = new BashGuardProbe(h);
});

afterEach(() => {
  probe.dispose();
  vi.restoreAllMocks();
  h.dispose();
});

const KB_RULES = [WORKSPACE, PERSONAL, UNRESOLVED];

function setupKb(): number {
  expect(h.send({ type: 'setWorkspaceRoot', workspaceId: ws.id, rootPath: root })).toEqual([]);
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

describe('verifier reproductions: KB writes (F-1 to F-8)', () => {
  it('every KB write is denied by the server and fails closed in the hook', () => {
    const agent = setupKb();
    expect(misses(agent, adversarialCases(root, note).kb, KB_RULES)).toEqual([]);
  });

  it('cd -, popd: later relative paths are checked against every earlier candidate', () => {
    const agent = setupKb();
    expect(misses(agent, adversarialCases(root, note).kbAt, KB_RULES, root)).toEqual([]);
  });

  it('F17 through attached short options and env -S (server side)', () => {
    const agent = setupKb();
    expect(misses(agent, adversarialCases(root, note).config, [CONFIG], undefined, false)).toEqual(
      [],
    );
  });
});

describe('verifier reproductions: role bypasses', () => {
  it('an agent without D cannot hide rm in env -S, time -p, function, case or deep nesting', () => {
    const agent = probe.launch(ws.dir, ['R', 'E']);
    const allowed = adversarialCases(root, note).role.filter((command) => {
      const verdict = probe.bash(agent, command);
      return !(verdict.verdict === 'deny' && verdict.rule === ROLE_DELETE);
    });
    expect(allowed).toEqual([]);
  });

  it('an R-only agent cannot edit through env -S', () => {
    const agent = probe.launch(ws.dir, ['R']);
    for (const command of adversarialCases(root, note).readOnlyEdit) {
      expect(probe.bash(agent, command), command).toMatchObject({ rule: ROLE_EDIT });
    }
  });
});

describe('the receiving command decides whether here-text is data', () => {
  it('cat and grep reading a heredoc or herestring that mentions .note stay allowed', () => {
    setupKb();
    const agent = probe.launch(ws.dir, ['R']);
    for (const command of [
      `cat <<'EOF'\n${note}/a.md\nEOF`,
      `grep x <<< "${note}/a.md"`,
      `cat <<EOF > /dev/null\n.note/other.md/x\nEOF`,
    ]) {
      expect(probe.bash(agent, command), command).toEqual({ verdict: 'allow' });
    }
  });
});
