/**
 * P3：工作空間預設權限角色與啟動快照（驗收 8、11）：setWorkspacePermissionRoles 的驗證、
 * 唯讀客戶端、持久化與舊版相容、LaunchAgent 的 permissionRoles 覆寫、啟動後不受影響。
 * 臨時 HOME（KbHarness），假 PTY，不呼叫真實 claude。
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_WORKSPACE_ID } from '../../core/src/constants.js';
import {
  PERMISSION_ROLES_INVALID_REASON,
  WRITE_GUARD_RULE_ROLE_EDIT as ROLE_EDIT,
} from '../src/constants.js';
import { handleRoleClientMessage } from '../src/roleClientMessages.js';
import { listWorkspaces, saveWorkspace, setWorkspaceRoot } from '../src/workspaces.js';
import { BashGuardProbe } from './bashGuardProbe.js';
import { KbHarness } from './curatorHarness.js';

let h: KbHarness;
let probe: BashGuardProbe;
let ws: { id: string; dir: string };

beforeEach(() => {
  h = new KbHarness();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ws = h.workspace('alpha');
  probe = new BashGuardProbe(h);
});

afterEach(() => {
  probe.dispose();
  vi.restoreAllMocks();
  h.dispose();
});

const rolesOf = (id: string) => listWorkspaces().find((w) => w.id === id)?.permissionRoles;
const setRoles = (roles: unknown, workspaceId: string = ws.id) =>
  h.send({ type: 'setWorkspacePermissionRoles', workspaceId, roles });
const file = () => path.join(h.tempHome, '.pixel-agents', 'workspaces.json');

describe('setWorkspacePermissionRoles (acceptance 11)', () => {
  it('stores distinct R/E/D in canonical order, rebroadcasts, and clears with null', () => {
    expect(setRoles(['E', 'R'])).toEqual([]);
    expect(rolesOf(ws.id)).toEqual(['R', 'E']);
    expect(h.broadcasts.at(-1)).toMatchObject({ type: 'workspacesLoaded' });
    expect(setRoles(null)).toEqual([]);
    expect(rolesOf(ws.id)).toBeUndefined();
    expect(Object.keys(listWorkspaces().find((w) => w.id === ws.id) ?? {})).not.toContain(
      'permissionRoles',
    );
  });

  it('an empty array is a valid default meaning every role is off', () => {
    expect(setRoles([])).toEqual([]);
    expect(rolesOf(ws.id)).toEqual([]);
    const agent = probe.launch(ws.dir);
    expect(h.store.get(agent)?.permissionRoles).toEqual([]);
    expect(probe.ask(agent, 'Read', {})).toMatchObject({ verdict: 'deny' });
  });

  it.each([[['R', 'R']], [['X']], [['r']], ['R'], [undefined], [{ R: true }], [[null]]])(
    'refuses %j and leaves the file untouched',
    (roles) => {
      setRoles(['R']);
      expect(setRoles(roles)).toEqual([
        { type: 'workspaceRejected', reason: PERMISSION_ROLES_INVALID_REASON },
      ]);
      expect(rolesOf(ws.id)).toEqual(['R']);
    },
  );

  it('refuses an unknown Workspace', () => {
    expect(setRoles(['R'], 'nope')).toMatchObject([{ type: 'workspaceRejected' }]);
  });

  it('saveWorkspace and setWorkspaceRoot keep the default roles', () => {
    setRoles(['R', 'D']);
    expect(saveWorkspace({ id: ws.id, name: 'renamed', directoryPaths: [ws.dir] }).ok).toBe(true);
    const root = path.join(h.tempHome, 'root');
    fs.mkdirSync(root);
    expect(setWorkspaceRoot({ workspaceId: ws.id, rootPath: root }, [])).toEqual({ ok: true });
    expect(rolesOf(ws.id)).toEqual(['R', 'D']);
    expect(setWorkspaceRoot({ workspaceId: ws.id, rootPath: null }, [])).toEqual({ ok: true });
    expect(rolesOf(ws.id)).toEqual(['R', 'D']);
  });
});

describe('workspaces.json compatibility (the rootPath precedent)', () => {
  it('older builds drop the field on write; this build then sees no default (no roles)', () => {
    setRoles(['R']);
    const raw = JSON.parse(fs.readFileSync(file(), 'utf-8')) as {
      workspaces: Array<Record<string, unknown>>;
    };
    expect(raw.workspaces.find((w) => w.id === ws.id)?.permissionRoles).toEqual(['R']);
    // P2 以前的解析器只複製它認得的欄位（id、name、directoryPaths、rootPath）並寫回。
    fs.writeFileSync(
      file(),
      JSON.stringify({
        workspaces: raw.workspaces.map(({ id, name, directoryPaths }) => ({
          id,
          name,
          directoryPaths,
        })),
      }),
    );
    expect(rolesOf(ws.id)).toBeUndefined();
    expect(h.store.get(probe.launch(ws.dir))?.permissionRoles).toBeNull();
  });

  it('a malformed permissionRoles makes the whole file untrusted, like rootPath', () => {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf-8')) as {
      workspaces: Array<Record<string, unknown>>;
    };
    for (const bad of [['R', 'R'], ['Z'], 'R', null]) {
      fs.writeFileSync(
        file(),
        JSON.stringify({
          workspaces: raw.workspaces.map((w) =>
            w.id === ws.id ? { ...w, permissionRoles: bad } : w,
          ),
        }),
      );
      expect(listWorkspaces().map((w) => w.id)).toEqual([DEFAULT_WORKSPACE_ID]);
    }
  });
});

describe('launch snapshot (acceptance 8)', () => {
  it('changing the Workspace default after launch does not change a running agent', () => {
    setRoles(['R']);
    const agent = probe.launch(ws.dir);
    expect(h.store.get(agent)?.permissionRoles).toEqual(['R']);
    setRoles(['R', 'E', 'D']);
    expect(h.store.get(agent)?.permissionRoles).toEqual(['R']);
    expect(probe.ask(agent, 'Write', { file_path: path.join(ws.dir, 'a') })).toMatchObject({
      rule: ROLE_EDIT,
    });
    setRoles(null);
    expect(probe.ask(agent, 'Write', { file_path: path.join(ws.dir, 'a') })).toMatchObject({
      rule: ROLE_EDIT,
    });
    // 之後啟動的 Agent 才用新的預設（null = 沒設角色）。
    expect(h.store.get(probe.launch(ws.dir))?.permissionRoles).toBeNull();
  });

  it('the launch override wins over the Workspace default, including an explicit null', () => {
    setRoles(['R']);
    expect(h.store.get(probe.launch(ws.dir, ['R', 'E']))?.permissionRoles).toEqual(['R', 'E']);
    expect(h.store.get(probe.launch(ws.dir, null))?.permissionRoles).toBeNull();
    expect(h.store.get(probe.launch(ws.dir))?.permissionRoles).toEqual(['R']);
  });

  it('launchAgent carries permissionRoles; an invalid value launches nothing', () => {
    setRoles(['R']);
    const before = h.store.nextAgentId.current;
    expect(
      h.send({ type: 'launchAgent', directoryPath: ws.dir, permissionRoles: ['D', 'E'] }),
    ).toEqual([]);
    expect(h.store.get(before)?.permissionRoles).toEqual(['E', 'D']);
    for (const bad of [['E', 'E'], ['W'], 'E', 1]) {
      const next = h.store.nextAgentId.current;
      h.send({ type: 'launchAgent', directoryPath: ws.dir, permissionRoles: bad });
      expect(h.store.nextAgentId.current).toBe(next);
      expect(h.store.has(next)).toBe(false);
    }
  });

  it('a Role launch with invalid permissionRoles is refused with roleRejected invalid', async () => {
    const replies: Array<Record<string, unknown>> = [];
    let launched = false;
    const pending = handleRoleClientMessage(
      { type: 'launchAgent', roleId: 'writer.md', directoryPath: ws.dir, permissionRoles: ['Q'] },
      {
        reply: (m) => replies.push(m),
        hostDirectories: () => [],
        available: true,
        launch: () => {
          launched = true;
          return 1;
        },
      },
    );
    await pending;
    expect(replies).toEqual([
      { type: 'roleRejected', code: 'invalid', reason: PERMISSION_ROLES_INVALID_REASON },
    ]);
    expect(launched).toBe(false);
  });
});
