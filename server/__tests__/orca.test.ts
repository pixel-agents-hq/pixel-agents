import { describe, expect, it } from 'vitest';

import { ORCA_AGENT_TYPES, ORCA_EVENT, ORCA_STATE } from '../src/providers/hook/orca/constants.js';
import {
  formatToolStatus,
  orcaAgentTypeFromEvent,
  orcaProvider,
  parseOrcaWorkspacePath,
} from '../src/providers/hook/orca/orca.js';
import { orcaProvider as registeredOrca } from '../src/providers/index.js';

const PTYID = '3f9a-uuid::/home/han/orca/pixel-agents@@e1';

function norm(raw: Record<string, unknown>): ReturnType<typeof orcaProvider.normalizeHookEvent> {
  return orcaProvider.normalizeHookEvent(raw);
}

describe('orcaProvider metadata', () => {
  it('is a hook provider with id "orca", protocolVersion 1, no team', () => {
    expect(orcaProvider.kind).toBe('hook');
    expect(orcaProvider.id).toBe('orca');
    expect(orcaProvider.protocolVersion).toBe(1);
    expect(orcaProvider.team).toBeUndefined();
  });

  it('is exported from the provider registry (M1 map registration)', () => {
    expect(registeredOrca).toBe(orcaProvider);
    expect(registeredOrca.id).toBe('orca');
  });

  it('install/uninstall are no-ops (push-based, nothing to manage)', async () => {
    await expect(orcaProvider.installHooks('http://x', 'tok')).resolves.toBeUndefined();
    await expect(orcaProvider.uninstallHooks()).resolves.toBeUndefined();
    await expect(orcaProvider.areHooksInstalled()).resolves.toBe(false);
  });
});

describe('parseOrcaWorkspacePath', () => {
  it('extracts a unix workspace path', () => {
    expect(parseOrcaWorkspacePath('uuid::/home/han/orca/pixel-agents@@e1')).toBe(
      '/home/han/orca/pixel-agents',
    );
  });

  it('extracts a windows workspace path (drive colon survives)', () => {
    expect(parseOrcaWorkspacePath('uuid::C:\\Users\\han\\orca\\new-game@@ab')).toBe(
      'C:\\Users\\han\\orca\\new-game',
    );
  });

  it('handles a missing @@hash segment', () => {
    expect(parseOrcaWorkspacePath('uuid::/ws/path')).toBe('/ws/path');
  });

  it('returns undefined without the :: separator', () => {
    expect(parseOrcaWorkspacePath('not-a-ptyid')).toBeUndefined();
  });
});

describe('orcaAgentTypeFromEvent', () => {
  it('recognizes all 17 Orca agent types', () => {
    for (const t of ORCA_AGENT_TYPES) {
      expect(orcaAgentTypeFromEvent({ agent_type: t })).toBe(t);
    }
  });

  it('returns undefined for unknown / missing / non-string agent_type', () => {
    expect(orcaAgentTypeFromEvent({ agent_type: 'not-a-cli' })).toBeUndefined();
    expect(orcaAgentTypeFromEvent({})).toBeUndefined();
    expect(orcaAgentTypeFromEvent({ agent_type: 123 })).toBeUndefined();
  });
});

describe('normalizeHookEvent — event kinds', () => {
  it('drops payloads missing session_id or hook_event_name', () => {
    expect(norm({ hook_event_name: ORCA_EVENT.TOOL_CALL })).toBeNull();
    expect(norm({ session_id: PTYID })).toBeNull();
    expect(norm({})).toBeNull();
  });

  it('session.start → sessionStart with cwd parsed from the ptyId', () => {
    const r = norm({ session_id: PTYID, hook_event_name: ORCA_EVENT.SESSION_START });
    expect(r?.sessionId).toBe(PTYID);
    expect(r?.event).toMatchObject({ kind: 'sessionStart', cwd: '/home/han/orca/pixel-agents' });
  });

  it('session.start prefers an explicit cwd + carries source', () => {
    const r = norm({
      session_id: PTYID,
      hook_event_name: ORCA_EVENT.SESSION_START,
      cwd: '/explicit',
      source: 'startup',
    });
    expect(r?.event).toMatchObject({ kind: 'sessionStart', cwd: '/explicit', source: 'startup' });
  });

  it('tool.call → toolStart with tool name + input', () => {
    const r = norm({
      session_id: PTYID,
      hook_event_name: ORCA_EVENT.TOOL_CALL,
      agent_type: 'codex',
      tool: { name: 'Read', input: { file_path: '/x/foo.ts' } },
    });
    expect(r?.event).toMatchObject({
      kind: 'toolStart',
      toolName: 'Read',
      input: { file_path: '/x/foo.ts' },
      runInBackground: false,
    });
  });

  it('tool.call carries runInBackground from tool.input', () => {
    const r = norm({
      session_id: PTYID,
      hook_event_name: ORCA_EVENT.TOOL_CALL,
      tool: { name: 'Agent', input: { run_in_background: true } },
    });
    expect(r?.event).toMatchObject({ kind: 'toolStart', runInBackground: true });
  });

  it('tool.result → toolEnd (current sentinel)', () => {
    const r = norm({ session_id: PTYID, hook_event_name: ORCA_EVENT.TOOL_RESULT });
    expect(r?.event).toEqual({ kind: 'toolEnd', toolId: 'current' });
  });

  it('permission.request → permissionRequest', () => {
    const r = norm({ session_id: PTYID, hook_event_name: ORCA_EVENT.PERMISSION_REQUEST });
    expect(r?.event).toEqual({ kind: 'permissionRequest' });
  });

  it('agent.end / session.end → sessionEnd', () => {
    expect(norm({ session_id: PTYID, hook_event_name: ORCA_EVENT.AGENT_END })?.event).toMatchObject(
      {
        kind: 'sessionEnd',
      },
    );
    expect(
      norm({ session_id: PTYID, hook_event_name: ORCA_EVENT.SESSION_END, reason: 'exit' })?.event,
    ).toEqual({ kind: 'sessionEnd', reason: 'exit' });
  });
});

describe('normalizeHookEvent — state-driven lifecycle', () => {
  it('state=idle → turnEnd(awaitingInput) on a non-tool event', () => {
    const r = norm({
      session_id: PTYID,
      hook_event_name: ORCA_EVENT.AGENT_START,
      state: ORCA_STATE.IDLE,
    });
    expect(r?.event).toEqual({ kind: 'turnEnd', awaitingInput: true });
  });

  it('state=done → sessionEnd', () => {
    const r = norm({
      session_id: PTYID,
      hook_event_name: ORCA_EVENT.ASSISTANT_MESSAGE,
      state: ORCA_STATE.DONE,
    });
    expect(r?.event).toMatchObject({ kind: 'sessionEnd' });
  });

  it('state=working (agent.start) → null (tools drive the active state)', () => {
    expect(
      norm({
        session_id: PTYID,
        hook_event_name: ORCA_EVENT.AGENT_START,
        state: ORCA_STATE.WORKING,
      }),
    ).toBeNull();
  });

  it('assistant.message with no state → null', () => {
    expect(norm({ session_id: PTYID, hook_event_name: ORCA_EVENT.ASSISTANT_MESSAGE })).toBeNull();
  });
});

describe('normalizeHookEvent — 17 agent types × event kinds', () => {
  const kinds = [
    { name: ORCA_EVENT.SESSION_START, expected: 'sessionStart' },
    { name: ORCA_EVENT.TOOL_CALL, expected: 'toolStart' },
    { name: ORCA_EVENT.TOOL_RESULT, expected: 'toolEnd' },
    { name: ORCA_EVENT.PERMISSION_REQUEST, expected: 'permissionRequest' },
    { name: ORCA_EVENT.AGENT_END, expected: 'sessionEnd' },
  ] as const;

  for (const agentType of ORCA_AGENT_TYPES) {
    for (const k of kinds) {
      it(`${agentType} · ${k.name} → ${k.expected} (sessionId passthrough)`, () => {
        const r = norm({
          session_id: PTYID,
          hook_event_name: k.name,
          agent_type: agentType,
          tool: { name: 'Read', input: {} },
        });
        expect(r).not.toBeNull();
        expect(r?.sessionId).toBe(PTYID);
        expect(r?.event.kind).toBe(k.expected);
      });
    }
  }
});

describe('formatToolStatus (cross-CLI, substring-matched)', () => {
  it('read-like tools', () => {
    expect(formatToolStatus('Read', { file_path: '/a/b/foo.ts' })).toBe('Reading foo.ts');
    expect(formatToolStatus('read_file', { path: '/a/bar.py' })).toBe('Reading bar.py');
    expect(formatToolStatus('cat', {})).toBe('Reading');
  });

  it('edit / write tools', () => {
    expect(formatToolStatus('Edit', { file_path: 'x/baz.ts' })).toBe('Editing baz.ts');
    expect(formatToolStatus('apply_patch', {})).toBe('Editing');
  });

  it('shell tools', () => {
    expect(formatToolStatus('Bash', { command: 'npm test' })).toBe('Running: npm test');
    expect(formatToolStatus('shell', {})).toBe('Running command');
  });

  it('search / fetch / subagent / default', () => {
    expect(formatToolStatus('Grep', {})).toBe('Searching code');
    expect(formatToolStatus('glob', {})).toBe('Searching files');
    expect(formatToolStatus('WebFetch', {})).toBe('Fetching web content');
    expect(formatToolStatus('Task', {})).toBe('Running subtask');
    expect(formatToolStatus('Qwx', {})).toBe('Using Qwx');
  });
});
