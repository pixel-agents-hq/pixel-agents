import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_WORKSPACE_ID } from '../../core/src/constants.js';
import { createAgentState } from '../src/agentState.js';
import { WORKSPACE_ID_MAX_LENGTH } from '../src/constants.js';
import { KbHarness } from './kbHarness.js';

/**
 * Workspace curators over the wire (S2): appointing, dismissing and every
 * refusal, through handleClientMessage with a real store, runtime, registry and
 * curator table. Eligible agents come only from the launcher with isKbEnabled.
 */

describe('Workspace curators', () => {
  let h: KbHarness;

  beforeEach(() => {
    h = new KbHarness();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    h.dispose();
  });

  const set = (workspaceId: unknown, agentId: unknown) =>
    h.send({ type: 'setWorkspaceCurator', workspaceId, agentId });
  const unset = (workspaceId: unknown) => h.send({ type: 'unsetWorkspaceCurator', workspaceId });
  const rejected = (code: string) => [
    { type: 'curatorRejected', code, reason: expect.any(String) },
  ];

  // ── Appoint / dismiss ───────────────────────────────────────

  it('appoints an eligible agent, refuses a second, and re-appoints after a dismissal', () => {
    const ws = h.workspace('alpha');
    const first = h.launch({ kb: true, directoryPath: ws.dir });
    const second = h.launch({ kb: true, directoryPath: ws.dir });

    expect(set(ws.id, first.id)).toEqual([]);
    expect(h.curatorBroadcasts()).toEqual([
      { type: 'workspaceCuratorChanged', workspaceId: ws.id, agentId: first.id },
    ]);

    expect(set(ws.id, second.id)).toEqual(rejected('exists'));
    expect(set(ws.id, first.id)).toEqual(rejected('exists'));
    expect(h.curators.curatorOf(ws.id)).toBe(first.id);

    expect(unset(ws.id)).toEqual([]);
    expect(h.curatorBroadcasts().at(-1)).toEqual({
      type: 'workspaceCuratorChanged',
      workspaceId: ws.id,
      agentId: null,
    });

    expect(set(ws.id, second.id)).toEqual([]);
    expect(h.curators.curatorOf(ws.id)).toBe(second.id);
  });

  it('refuses dismissing a Workspace that has no curator', () => {
    const ws = h.workspace('alpha');
    expect(unset(ws.id)).toEqual(rejected('invalid'));
    expect(unset(DEFAULT_WORKSPACE_ID)).toEqual(rejected('invalid'));
    expect(h.curatorBroadcasts()).toEqual([]);
  });

  it("keys the default Workspace one way ('default' and undefined are the same)", () => {
    const a = h.launch({ kb: true }); // no Directory: workspaceId undefined
    const b = h.launch({ kb: true });
    expect(h.store.get(a.id!)!.workspaceId).toBeUndefined();
    expect(h.capabilities.verify(a.token)?.workspaceId).toBe(DEFAULT_WORKSPACE_ID);

    expect(set(DEFAULT_WORKSPACE_ID, a.id)).toEqual([]);
    expect(h.curatorBroadcasts()).toEqual([
      { type: 'workspaceCuratorChanged', workspaceId: DEFAULT_WORKSPACE_ID, agentId: a.id },
    ]);
    expect(h.curators.curatorOf(undefined)).toBe(a.id);
    expect(set(DEFAULT_WORKSPACE_ID, b.id)).toEqual(rejected('exists'));
    expect(h.curators.list()).toEqual([{ workspaceId: DEFAULT_WORKSPACE_ID, agentId: a.id }]);
  });

  // ── Refusals ────────────────────────────────────────────────

  it('refuses malformed agent ids as invalid', () => {
    const ws = h.workspace('alpha');
    h.launch({ kb: true, directoryPath: ws.dir });
    for (const agentId of ['1', '5', 0, -1, NaN, Infinity, 1.5, null, undefined, [1], { id: 1 }]) {
      expect(set(ws.id, agentId)).toEqual(rejected('invalid'));
    }
    expect(h.curatorBroadcasts()).toEqual([]);
  });

  it('refuses unknown, empty, overlong or non-string Workspace ids as invalid', () => {
    const ws = h.workspace('alpha');
    const { id } = h.launch({ kb: true, directoryPath: ws.dir });
    for (const workspaceId of [
      'no-such-workspace',
      '',
      'x'.repeat(WORKSPACE_ID_MAX_LENGTH + 1),
      `${ws.id}${'x'.repeat(WORKSPACE_ID_MAX_LENGTH)}`,
      42,
      null,
      undefined,
      [ws.id],
    ]) {
      expect(set(workspaceId, id)).toEqual(rejected('invalid'));
      expect(unset(workspaceId)).toEqual(rejected('invalid'));
    }
    expect(h.curatorBroadcasts()).toEqual([]);
  });

  it('refuses an agent from another Workspace, and ids nobody holds, as not_eligible', () => {
    const alpha = h.workspace('alpha');
    const beta = h.workspace('beta');
    const inBeta = h.launch({ kb: true, directoryPath: beta.dir });
    expect(set(alpha.id, inBeta.id)).toEqual(rejected('not_eligible'));
    expect(set(DEFAULT_WORKSPACE_ID, inBeta.id)).toEqual(rejected('not_eligible'));
    expect(set(alpha.id, 1_000_000)).toEqual(rejected('not_eligible'));
    expect(set(alpha.id, 999)).toEqual(rejected('not_eligible'));
    expect(h.curatorBroadcasts()).toEqual([]);
  });

  it('refuses agents that hold no capability as not_eligible', () => {
    const ws = h.workspace('alpha');
    const other = h.workspace('beta');

    // A PTY agent launched where KB is off.
    const kbOff = h.launch({ kb: (w) => w === other.id, directoryPath: ws.dir });
    expect(kbOff.token).toBeUndefined();
    // A PTY agent launched with no isKbEnabled at all (production today).
    const plain = h.launch({ directoryPath: ws.dir });

    // An adopted external agent.
    const external = createAgentState({
      id: 50,
      sessionId: 'ext',
      isExternal: true,
      projectDir: h.projectDir,
      jsonlFile: path.join(h.projectDir, 'ext.jsonl'),
      workspaceId: ws.id,
    });
    h.store.set(50, external);

    // A teammate of a capability-holding Lead (same Workspace, own id).
    const lead = h.launch({ kb: true, directoryPath: ws.dir });
    h.store.set(
      51,
      createAgentState({
        id: 51,
        sessionId: 'mate',
        isExternal: true,
        projectDir: h.projectDir,
        jsonlFile: path.join(h.projectDir, 'mate.jsonl'),
        leadAgentId: lead.id!,
        agentName: 'helper',
        workspaceId: ws.id,
      }),
    );

    // A restored external agent.
    const restoredFile = path.join(h.projectDir, 'restored.jsonl');
    fs.writeFileSync(restoredFile, '');
    const adapter = h.store.getAdapter()!;
    adapter.saveAgents([
      ...adapter.loadAgents(),
      {
        id: 60,
        sessionId: 'restored',
        terminalName: '',
        isExternal: true,
        jsonlFile: restoredFile,
        projectDir: h.projectDir,
        workspaceId: ws.id,
      },
    ]);
    h.runtime.restoreExternalAgents();
    expect(h.store.get(60)?.workspaceId).toBe(ws.id);

    for (const agentId of [kbOff.id, plain.id, 50, 51, 60]) {
      expect(set(ws.id, agentId)).toEqual(rejected('not_eligible'));
    }
    expect(h.curatorBroadcasts()).toEqual([]);
    // The Lead itself is eligible.
    expect(set(ws.id, lead.id)).toEqual([]);
  });

  // ── Access ──────────────────────────────────────────────────

  it('drops a read-only client silently, changing nothing', () => {
    const ws = h.workspace('alpha');
    const { id } = h.launch({ kb: true, directoryPath: ws.dir });
    const readOnly = h.ctx({ privileged: false });

    expect(
      h.send({ type: 'setWorkspaceCurator', workspaceId: ws.id, agentId: id }, readOnly),
    ).toEqual([]);
    expect(h.curators.list()).toEqual([]);

    expect(set(ws.id, id)).toEqual([]);
    expect(h.send({ type: 'unsetWorkspaceCurator', workspaceId: ws.id }, readOnly)).toEqual([]);
    expect(h.curators.curatorOf(ws.id)).toBe(id);
    expect(h.curatorBroadcasts()).toHaveLength(1);
  });

  it('answers unavailable without a terminal manager, runtime or registry', () => {
    const ws = h.workspace('alpha');
    const { id } = h.launch({ kb: true, directoryPath: ws.dir });
    for (const missing of [
      { ptyManager: undefined },
      { runtime: undefined },
      { capabilities: undefined },
      { curators: undefined },
    ]) {
      const context = h.ctx(missing);
      expect(
        h.send({ type: 'setWorkspaceCurator', workspaceId: ws.id, agentId: id }, context),
      ).toEqual(rejected('unavailable'));
      expect(h.send({ type: 'unsetWorkspaceCurator', workspaceId: ws.id }, context)).toEqual(
        rejected('unavailable'),
      );
      const loaded = h
        .send({ type: 'webviewReady' }, context)
        .find((m) => m.type === 'curatorsLoaded');
      expect(loaded).toEqual({ type: 'curatorsLoaded', available: false, curators: [] });
    }
    expect(h.curatorBroadcasts()).toEqual([]);
  });

  it('offers no curator controls while nothing can enable a KB (isKbEnabled not wired)', () => {
    const loaded = h
      .send({ type: 'webviewReady' }, h.ctx({ isKbEnabled: undefined }))
      .find((m) => m.type === 'curatorsLoaded');
    expect(loaded).toEqual({ type: 'curatorsLoaded', available: false, curators: [] });
  });

  it('sends curatorsLoaded to the connecting client only, with the current curators', () => {
    const ws = h.workspace('alpha');
    const { id } = h.launch({ kb: true, directoryPath: ws.dir });
    set(ws.id, id);

    const replies = h.send({ type: 'webviewReady' });
    const loaded = replies.find((m) => m.type === 'curatorsLoaded');
    expect(loaded).toEqual({
      type: 'curatorsLoaded',
      available: true,
      curators: [{ workspaceId: ws.id, agentId: id }],
    });
    // After the Workspace list, before any agent names one.
    const order = replies.map((m) => m.type);
    expect(order.indexOf('curatorsLoaded')).toBeGreaterThan(order.indexOf('workspacesLoaded'));
    expect(order.indexOf('curatorsLoaded')).toBeLessThan(order.indexOf('existingAgents'));
    expect(h.broadcasts.some((m) => m.type === 'curatorsLoaded')).toBe(false);

    // A read-only office is told too (it hides the controls itself).
    const readOnly = h
      .send({ type: 'webviewReady' }, h.ctx({ privileged: false }))
      .find((m) => m.type === 'curatorsLoaded');
    expect(readOnly).toEqual(loaded);
  });

  it('removing a Workspace clears its curator record', () => {
    const ws = h.workspace('alpha');
    const { id } = h.launch({ kb: true, directoryPath: ws.dir });
    set(ws.id, id);

    h.send({ type: 'removeWorkspace', id: ws.id });

    expect(h.curators.list()).toEqual([]);
    expect(h.curatorBroadcasts().filter((m) => m.agentId === null)).toEqual([
      { type: 'workspaceCuratorChanged', workspaceId: ws.id, agentId: null },
    ]);
  });

  it('never writes a curator to disk', () => {
    const ws = h.workspace('alpha');
    const { id } = h.launch({ kb: true, directoryPath: ws.dir });
    const dir = path.join(h.tempHome, '.pixel-agents');
    const snapshot = () =>
      Object.fromEntries(
        fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf-8')]),
      );
    const before = snapshot();
    set(ws.id, id);
    unset(ws.id);
    expect(snapshot()).toEqual(before);
  });
});
