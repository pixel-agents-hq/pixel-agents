/**
 * P2 驗收 3、9、11、12：識別鍵與 Agent 狀態、F17 拒絕清單、curator 的 store 事件清除。
 * 真的 launcher（假 PTY），臨時 HOME，不發任何 capability、不呼叫真實 claude。
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_WORKSPACE_ID } from '../../core/src/constants.js';
import {
  CAPABILITY_ENV_NAME,
  KB_PERSONAL_RESERVED_KEY,
  WRITE_GUARD_RULE_KB_WORKSPACE as WORKSPACE,
  WRITE_GUARD_RULE_PROTECTED_CONFIG as CONFIG,
} from '../src/constants.js';
import { writeRoleSnapshot } from '../src/roleStorage.js';
import { KbHarness } from './curatorHarness.js';
import { GuardProbe } from './kbRulesProbe.js';

let h: KbHarness;
let probe: GuardProbe;
let ws: { id: string; dir: string };
let root: string;

beforeEach(() => {
  h = new KbHarness();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ws = h.workspace('alpha');
  root = path.join(h.tempHome, 'alpha-root');
  fs.mkdirSync(path.join(root, '.note'), { recursive: true });
  probe = new GuardProbe(h);
});

afterEach(() => {
  probe.dispose();
  vi.restoreAllMocks();
  h.dispose();
});

const setRoot = (rootPath: string | null) =>
  expect(h.send({ type: 'setWorkspaceRoot', workspaceId: ws.id, rootPath })).toEqual([]);
const ownRoot = (id: number) => probe.guard.getKbState().agents.get(id)?.ownRoot;

describe('agent identity at launch', () => {
  it('records the roleId (not the display name) and the Directory realpath', async () => {
    const link = path.join(h.tempHome, 'alpha-link');
    fs.symlinkSync(ws.dir, link);
    const id = await probe.launch(link, 'writer.md');
    const agent = h.store.get(id)!;
    expect(agent.roleId).toBe('writer.md');
    expect(agent.roleName).toBe('writer');
    expect(agent.directoryRealPath).toBe(fs.realpathSync(ws.dir));
    // 沒有任何 capability 被發出。
    expect(h.spawned.at(-1)?.options.env?.[CAPABILITY_ENV_NAME]).toBeUndefined();
  });

  it('different Roles in one Directory get different paths; the same Role the same one', async () => {
    setRoot(root);
    const a1 = await probe.launch(ws.dir, 'a.md');
    const a2 = await probe.launch(ws.dir, 'a.md');
    const b = await probe.launch(ws.dir, 'b.md');
    const none = await probe.launch(ws.dir);
    expect(ownRoot(a1)).toBe(path.join(ws.dir, '.note', 'a.md'));
    expect(ownRoot(a2)).toBe(ownRoot(a1));
    expect(ownRoot(b)).toBe(path.join(ws.dir, '.note', 'b.md'));
    expect(ownRoot(none)).toBe(path.join(ws.dir, '.note', KB_PERSONAL_RESERVED_KEY));
    // 同角色共用：互相可寫（已知限制）。
    expect(probe.ask(a2, 'Write', path.join(ws.dir, '.note', 'a.md', 'x'))).toEqual({
      verdict: 'allow',
    });
  });

  it('a relaunch after the first agent exits (a restart: PTY agents are never restored) gets the same path', async () => {
    setRoot(root);
    const first = await probe.launch(ws.dir, 'a.md');
    const before = ownRoot(first);
    h.spawned.at(-1)!.pty.exit(0);
    expect(h.store.has(first)).toBe(false);
    const second = await probe.launch(ws.dir, 'a.md');
    expect(second).not.toBe(first);
    expect(ownRoot(second)).toBe(before);
  });

  it('refuses a launch whose roleId is a path or outside the allowlist', async () => {
    for (const roleId of ['../evil.md', 'a/b.md', 'noext', '.x.md', 'CON.md']) {
      const snapshotPath = await writeRoleSnapshot(Buffer.from('x'));
      const before = h.spawned.length;
      expect(
        h.launch({ directoryPath: ws.dir, role: { name: 'x', roleId, snapshotPath } }).id,
      ).toBe(null);
      expect(h.spawned.length).toBe(before);
      expect(fs.existsSync(snapshotPath)).toBe(false);
    }
  });
});

describe('F17 deny list (file tools)', () => {
  it('denies Write and Edit to ~/.pixel-agents/, ~/.claude/settings*.json and <Directory>/.claude/', async () => {
    const claudeHome = path.join(h.tempHome, '.claude');
    fs.mkdirSync(claudeHome, { recursive: true });
    // settings.json 常被 symlink 到 dotfiles：以目標路徑寫入也要擋。
    const dotfiles = path.join(h.tempHome, 'dotfiles');
    fs.mkdirSync(dotfiles);
    fs.writeFileSync(path.join(dotfiles, 'claude-settings.json'), '{}');
    fs.symlinkSync(
      path.join(dotfiles, 'claude-settings.json'),
      path.join(claudeHome, 'settings.json'),
    );
    setRoot(root);
    const agent = await probe.launch(ws.dir);
    const targets = [
      path.join(h.tempHome, '.pixel-agents', 'workspaces.json'),
      path.join(h.tempHome, '.pixel-agents', 'hooks', 'claude-hook.js'),
      path.join(claudeHome, 'settings.json'),
      path.join(dotfiles, 'claude-settings.json'),
      path.join(claudeHome, 'settings.local.json'),
      path.join(ws.dir, '.claude', 'roles', 'a.md'),
      path.join(ws.dir, '.claude', 'settings.json'),
    ];
    for (const tool of ['Write', 'Edit']) {
      for (const target of targets) {
        // 回報的路徑是解過 symlink 的路徑（settings.json -> dotfiles）。
        expect(probe.ask(agent, tool, target), `${tool} ${target}`).toMatchObject({
          verdict: 'deny',
          rule: CONFIG,
        });
      }
    }
    // 名稱不符的檔案、其他 Directory 的 .claude/ 不在清單內。
    expect(probe.ask(agent, 'Write', path.join(claudeHome, 'CLAUDE.md'))).toEqual({
      verdict: 'allow',
    });
  });

  it('after a cd elsewhere, a relative write back into the launch Directory .claude/ is still denied', async () => {
    setRoot(root);
    const agent = await probe.launch(ws.dir);
    expect(probe.ask(agent, 'Edit', '../alpha/.claude/settings.local.json', root)).toMatchObject({
      rule: CONFIG,
    });
  });

  it('is off while the agent Workspace has no root', async () => {
    const agent = await probe.launch(ws.dir);
    expect(probe.ask(agent, 'Write', path.join(h.tempHome, '.pixel-agents', 'x'))).toEqual({
      verdict: 'allow',
    });
  });
});

describe('curator clearing without any capability', () => {
  const appoint = (agentId: number, workspaceId = ws.id) =>
    h.send({ type: 'setWorkspaceCurator', workspaceId, agentId });

  it('(a) removing the agent clears the curator and announces agentId null', async () => {
    const id = await probe.launch(ws.dir);
    expect(appoint(id)).toEqual([]);
    h.send({ type: 'closeAgent', id });
    expect(h.curators.curatorOf(ws.id)).toBeNull();
    expect(h.curatorBroadcasts().at(-1)).toEqual({
      type: 'workspaceCuratorChanged',
      workspaceId: ws.id,
      agentId: null,
    });
  });

  it('(b) moving the curator to another Workspace: its write to the old .note/ is denied', async () => {
    setRoot(root);
    const beta = h.workspace('beta');
    const id = await probe.launch(ws.dir);
    expect(appoint(id)).toEqual([]);
    const target = path.join(root, '.note', 'a.md');
    expect(probe.ask(id, 'Write', target)).toEqual({ verdict: 'allow' });
    h.store.setAgentWorkspace(id, beta.id);
    expect(h.curators.curatorOf(ws.id)).toBeNull();
    expect(probe.ask(id, 'Write', target)).toMatchObject({ verdict: 'deny' });
    // 即使工作空間 KB 的 curator 記錄還在（模擬遺漏），換了工作空間仍 deny。
    const again = await probe.launch(ws.dir);
    expect(appoint(again)).toEqual([]);
    h.store.get(again)!.workspaceId = beta.id;
    probe.guard.update();
    expect(probe.ask(again, 'Write', target)).toMatchObject({ rule: WORKSPACE });
  });

  it('(c) after agentsCleared the table is empty and a new agent can be appointed', async () => {
    const id = await probe.launch(ws.dir);
    expect(appoint(id)).toEqual([]);
    h.store.clear();
    expect(h.curators.list()).toEqual([]);
    expect(h.curatorBroadcasts().at(-1)).toMatchObject({ workspaceId: ws.id, agentId: null });
    const next = await probe.launch(ws.dir);
    expect(appoint(next)).toEqual([]);
    expect(h.curators.curatorOf(ws.id)).toBe(next);
  });

  it('the default Workspace works the same way', async () => {
    const id = await probe.launch(h.tempHome);
    expect(appoint(id, DEFAULT_WORKSPACE_ID)).toEqual([]);
    h.send({ type: 'closeAgent', id });
    expect(h.curators.curatorOf(undefined)).toBeNull();
  });
});
