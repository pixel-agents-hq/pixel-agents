/** P4：agentGuardStatus 的證據判準、廣播時機、去重與握手補送。 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import type { HookChainCheck } from '../src/writeGuard/guardStatus.js';
import { GuardStatusReporter } from '../src/writeGuard/guardStatusReporter.js';
import { WriteGuard } from '../src/writeGuard/writeGuard.js';
import { KbHarness } from './curatorHarness.js';

type Message = Record<string, unknown>;

let h: KbHarness;
let guard: WriteGuard;
let reporter: GuardStatusReporter;
let chain: HookChainCheck;
let probeCalls: number;
let sent: Message[];

const statuses = (id?: number): Message[] =>
  sent.filter((m) => m.type === 'agentGuardStatus' && (id === undefined || m.id === id));
const lastStatus = (id: number): Message => statuses(id).at(-1)!;

function sessionOf(id: number): string {
  return h.store.get(id)!.sessionId;
}

function askVerdict(id: number): void {
  guard.verdict({
    tool_name: 'Read',
    session_id: sessionOf(id),
    cwd: h.tempHome,
    paths: [],
  });
}

function setRoot(workspaceId: string, dir: string): void {
  const root = path.join(dir, 'kbroot');
  fs.mkdirSync(root, { recursive: true });
  expect(h.send({ type: 'setWorkspaceRoot', workspaceId, rootPath: root })).toEqual([]);
}

beforeEach(() => {
  h = new KbHarness();
  chain = { hooksInstalled: true, preToolUsePresent: true, scriptPresent: true };
  probeCalls = 0;
  sent = [];
  guard = new WriteGuard({
    store: h.store,
    ptyManager: h.manager,
    sessions: h.runtime,
    curators: h.curators,
  });
  reporter = new GuardStatusReporter({
    store: h.store,
    ptyManager: h.manager,
    guard,
    curators: h.curators,
    sessions: h.runtime,
    broadcast: (m) => sent.push(m),
    probeChain: () => {
      probeCalls++;
      return { ...chain };
    },
  });
});

afterEach(() => {
  reporter.dispose();
  guard.dispose();
  h.dispose();
});

describe('evidence: the first verdict request', () => {
  it('is inactive with awaiting_first_verdict until a verdict request arrives, then active', () => {
    const ws = h.workspace('a');
    setRoot(ws.id, ws.dir);
    const agent = h.launch({ directoryPath: ws.dir });
    const id = agent.id!;
    expect(lastStatus(id)).toMatchObject({ active: false });
    expect(lastStatus(id).reasons).toContain('awaiting_first_verdict');

    askVerdict(id);
    expect(lastStatus(id)).toMatchObject({ id, active: true });
  });

  it('returns to awaiting_first_verdict when the session id changes (/clear)', () => {
    const ws = h.workspace('a');
    setRoot(ws.id, ws.dir);
    const id = h.launch({ directoryPath: ws.dir }).id!;
    askVerdict(id);
    expect(lastStatus(id).active).toBe(true);

    h.store.get(id)!.sessionId = 'cleared-session';
    reporter.update();
    expect(lastStatus(id)).toMatchObject({ active: false });
    expect(lastStatus(id).reasons).toContain('awaiting_first_verdict');
  });

  it('does not treat an unknown session id as evidence for anyone', () => {
    const id = h.launch().id!;
    guard.verdict({ tool_name: 'Read', session_id: 'stranger', cwd: h.tempHome, paths: [] });
    expect(guard.hasSeenVerdict('stranger')).toBe(false);
    expect(lastStatus(id).active).toBe(false);
  });
});

describe('reasons', () => {
  it('lists no_workspace_root then no_curator without changing active', () => {
    const ws = h.workspace('a');
    const id = h.launch({ directoryPath: ws.dir }).id!;
    askVerdict(id);
    expect(lastStatus(id)).toMatchObject({ active: true, reasons: ['no_workspace_root'] });

    setRoot(ws.id, ws.dir);
    expect(lastStatus(id)).toMatchObject({ active: true, reasons: ['no_curator'] });

    h.send({ type: 'setWorkspaceCurator', workspaceId: ws.id, agentId: id });
    expect(lastStatus(id)).toMatchObject({ active: true, reasons: [] });
  });

  it('reports each chain failure as inactive with its own reason', () => {
    const id = h.launch().id!;
    askVerdict(id);
    const cases: Array<[HookChainCheck, string]> = [
      [
        { hooksInstalled: false, preToolUsePresent: false, scriptPresent: true },
        'hooks_not_installed',
      ],
      [
        { hooksInstalled: true, preToolUsePresent: false, scriptPresent: true },
        'pretooluse_hook_missing',
      ],
      [
        { hooksInstalled: true, preToolUsePresent: true, scriptPresent: false },
        'hook_script_missing',
      ],
    ];
    for (const [next, reason] of cases) {
      chain = next;
      reporter.refreshChain();
      expect(lastStatus(id).active).toBe(false);
      expect(lastStatus(id).reasons).toContain(reason);
    }
    chain = { hooksInstalled: true, preToolUsePresent: true, scriptPresent: true };
    reporter.refreshChain();
    expect(lastStatus(id).active).toBe(true);
  });

  it('marks an externally adopted agent not_standalone_agent', () => {
    h.store.set(
      7,
      createAgentState({
        id: 7,
        sessionId: 'ext',
        projectDir: h.tempHome,
        jsonlFile: path.join(h.tempHome, 'ext.jsonl'),
        isExternal: true,
      }),
    );
    expect(lastStatus(7)).toEqual({
      type: 'agentGuardStatus',
      id: 7,
      active: false,
      reasons: ['not_standalone_agent'],
      permissionRoles: null,
    });
  });
});

describe('permissionRoles', () => {
  it('mirrors the launch snapshot and ignores later workspace default changes', () => {
    const ws = h.workspace('a');
    const id = h.launch({ directoryPath: ws.dir, permissionRoles: ['R', 'E'] }).id!;
    expect(lastStatus(id).permissionRoles).toEqual(['R', 'E']);

    h.send({ type: 'setWorkspacePermissionRoles', workspaceId: ws.id, roles: ['D'] });
    reporter.update();
    expect(lastStatus(id).permissionRoles).toEqual(['R', 'E']);

    const noRoles = h.launch().id!;
    expect(lastStatus(noRoles).permissionRoles).toBeNull();
  });
});

describe('broadcast timing and dedup', () => {
  it('sends on agent add, resends on changes, and never resends identical content', () => {
    const ws = h.workspace('a');
    const id = h.launch({ directoryPath: ws.dir }).id!;
    const afterAdd = statuses(id).length;
    expect(afterAdd).toBeGreaterThanOrEqual(1);

    reporter.update();
    reporter.update();
    expect(statuses(id).length).toBe(afterAdd);

    setRoot(ws.id, ws.dir); // root change
    const afterRoot = statuses(id).length;
    expect(afterRoot).toBe(afterAdd + 1);

    h.send({ type: 'setWorkspaceCurator', workspaceId: ws.id, agentId: id }); // curator change
    expect(statuses(id).length).toBe(afterRoot + 1);

    askVerdict(id); // first verdict
    expect(statuses(id).length).toBe(afterRoot + 2);
    askVerdict(id); // second verdict: no news
    expect(statuses(id).length).toBe(afterRoot + 2);

    chain = { hooksInstalled: true, preToolUsePresent: false, scriptPresent: true };
    reporter.refreshChain(); // hooks state change
    expect(statuses(id).length).toBe(afterRoot + 3);
    reporter.refreshChain(); // same chain: no resend
    expect(statuses(id).length).toBe(afterRoot + 3);
  });

  it('runs the chain probe only on refreshChain and the interval, not on other triggers', () => {
    const ws = h.workspace('a');
    const id = h.launch({ directoryPath: ws.dir }).id!;
    const baseline = probeCalls; // the constructor's one probe
    setRoot(ws.id, ws.dir);
    askVerdict(id);
    reporter.update();
    expect(probeCalls).toBe(baseline);
    reporter.refreshChain();
    expect(probeCalls).toBe(baseline + 1);
  });
});

describe('handshake', () => {
  it('sends every existing agent its status after existingAgents, read-only clients included', () => {
    const first = h.launch().id!;
    h.store.set(
      9,
      createAgentState({
        id: 9,
        sessionId: 'ext',
        projectDir: h.tempHome,
        jsonlFile: path.join(h.tempHome, 'ext.jsonl'),
        isExternal: true,
      }),
    );
    for (const privileged of [true, false]) {
      const replies = h.send(
        { type: 'webviewReady' },
        h.ctx({ privileged, guardStatus: reporter }),
      );
      const types = replies.map((m) => m.type);
      const existingAt = types.indexOf('existingAgents');
      const guardAt = replies.flatMap((m, i) => (m.type === 'agentGuardStatus' ? [i] : []));
      expect(existingAt).toBeGreaterThanOrEqual(0);
      expect(guardAt).toHaveLength(2);
      expect(Math.min(...guardAt)).toBeGreaterThan(existingAt);
      const byId = new Map(
        replies.filter((m) => m.type === 'agentGuardStatus').map((m) => [m.id, m]),
      );
      expect(byId.get(9)).toMatchObject({ active: false, reasons: ['not_standalone_agent'] });
      expect(byId.get(first)).toMatchObject({ active: false });
    }
  });

  it('sends no agentGuardStatus when the host has no reporter (VS Code embedded)', () => {
    h.launch();
    const replies = h.send({ type: 'webviewReady' }, h.ctx());
    expect(replies.some((m) => m.type === 'agentGuardStatus')).toBe(false);
  });
});

describe('message contents', () => {
  it('carries only protocol fields, no paths or tokens', () => {
    const ws = h.workspace('secret-dir');
    setRoot(ws.id, ws.dir);
    const id = h.launch({ directoryPath: ws.dir, kb: true }).id!;
    askVerdict(id);
    for (const message of statuses()) {
      expect(Object.keys(message).sort()).toEqual(
        ['active', 'id', 'permissionRoles', 'reasons', 'type'].sort(),
      );
      const text = JSON.stringify(message);
      expect(text).not.toContain(h.tempHome);
      expect(text).not.toContain(sessionOf(id));
    }
  });
});
