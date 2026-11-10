/**
 * P3 的 Bash 基準指令（mock 建立）：每一條都寫入工作空間 KB，對非 curator 必須同時被
 * 伺服器裁決拒絕，且伺服器不可達時 hook 本地也 fail-closed。任何一條放行即為誤放行
 * （停止條件）。另列幾條讀取類指令，確認不被誤擋。
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WRITE_GUARD_RULE_KB_PERSONAL as PERSONAL,
  WRITE_GUARD_RULE_KB_WORKSPACE as WORKSPACE,
} from '../src/constants.js';
import { permissionRolesBenchmark } from './bashBenchmarkCases.js';
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
  fs.writeFileSync(path.join(note, 'a.md'), 'a');
  fs.writeFileSync(path.join(ws.dir, 'src.md'), 's');
  expect(h.send({ type: 'setWorkspaceRoot', workspaceId: ws.id, rootPath: root })).toEqual([]);
  probe = new BashGuardProbe(h);
});

afterEach(() => {
  probe.dispose();
  vi.restoreAllMocks();
  h.dispose();
});

describe('benchmark: every write into the Workspace KB is caught', () => {
  it('server verdict denies and the hook-local fallback fails closed, for each command', () => {
    const agent = probe.launch(ws.dir, ['R', 'E', 'D']);
    const curator = probe.launch(ws.dir, ['R', 'E', 'D']);
    expect(h.send({ type: 'setWorkspaceCurator', workspaceId: ws.id, agentId: curator })).toEqual(
      [],
    );
    const { writes } = permissionRolesBenchmark(root, note);
    expect(writes.length).toBeGreaterThan(40);
    const missed: string[] = [];
    for (const command of writes) {
      const verdict = probe.bash(agent, command);
      const fallback = probe.plan(agent, 'Bash', { command }).fallback.decision;
      // 必須是真的命中 KB 規則，而不是「無法判斷」的保守拒絕。`cd X; cmd` 也可能在
      // 原目錄（Agent Directory）執行，那一側命中的是個人 KB 規則。
      const hitKb =
        verdict.verdict === 'deny' && (verdict.rule === WORKSPACE || verdict.rule === PERSONAL);
      if (!hitKb || fallback !== 'deny') {
        missed.push(`${command} -> server=${JSON.stringify(verdict)} hook=${fallback}`);
      }
    }
    expect(missed).toEqual([]);
  });

  it('read-only access to the KB is not blocked', () => {
    const agent = probe.launch(ws.dir, ['R']);
    for (const command of permissionRolesBenchmark(root, note).reads) {
      expect(probe.bash(agent, command), command).toEqual({ verdict: 'allow' });
      expect(probe.plan(agent, 'Bash', { command }).fallback.decision, command).toBe('allow');
    }
  });
});
