import { describe, expect, it } from 'vitest';

import { hermesProvider } from '../src/providers/hook/hermes/hermes.js';

const normalize = (event: Record<string, unknown>) => hermesProvider.normalizeHookEvent(event);

describe('Hermes hook provider', () => {
  it('maps session, exact concurrent tools, turn end, and finalization', () => {
    expect(
      normalize({ hook_event_name: 'on_session_start', session_id: 's1', cwd: '/work' }),
    ).toEqual({ sessionId: 's1', event: { kind: 'sessionStart', cwd: '/work' } });
    expect(
      normalize({
        hook_event_name: 'pre_tool_call',
        session_id: 's1',
        tool_name: 'read_file',
        tool_input: { path: 'a.ts' },
        extra: { tool_call_id: 'call-a' },
      }),
    ).toEqual({
      sessionId: 's1',
      event: {
        kind: 'toolStart',
        toolId: 'call-a',
        toolName: 'read_file',
        input: { path: 'a.ts' },
      },
    });
    expect(
      normalize({
        hook_event_name: 'post_tool_call',
        session_id: 's1',
        extra: { tool_call_id: 'call-a' },
      }),
    ).toEqual({ sessionId: 's1', event: { kind: 'toolEnd', toolId: 'call-a' } });
    expect(normalize({ hook_event_name: 'on_session_end', session_id: 's1' })).toEqual({
      sessionId: 's1',
      event: { kind: 'turnEnd', awaitingInput: true },
    });
    expect(normalize({ hook_event_name: 'on_session_finalize', session_id: 's1' })).toEqual({
      sessionId: 's1',
      event: { kind: 'sessionEnd', reason: 'finalize' },
    });
  });

  it('routes independent children and approvals without exposing approval payloads', () => {
    expect(
      normalize({
        hook_event_name: 'subagent_start',
        session_id: 'parent',
        extra: {
          child_session_id: 'child-1',
          child_subagent_id: 'worker-1',
          child_role: 'researcher',
          child_goal: 'Find evidence',
          parent_turn_id: 'turn-1',
        },
      }),
    ).toEqual({
      sessionId: 'parent',
      event: {
        kind: 'subagentStart',
        parentToolId: 'turn-1',
        toolId: 'worker-1',
        childSessionId: 'child-1',
        toolName: 'researcher',
        input: 'Find evidence',
        runInBackground: true,
      },
    });
    expect(
      normalize({
        hook_event_name: 'pre_approval_request',
        extra: { session_key: 'session-key', command: 'do not forward' },
      }),
    ).toEqual({ sessionId: 'session-key', event: { kind: 'permissionRequest' } });
    expect(
      normalize({
        hook_event_name: 'post_approval_response',
        extra: { session_key: 'session-key', decision: 'do not forward' },
      }),
    ).toEqual({ sessionId: 'session-key', event: { kind: 'permissionResolved' } });
  });

  it('drops unknown, malformed, and incomplete events', () => {
    expect(normalize({})).toBeNull();
    expect(normalize({ hook_event_name: 'future_event', session_id: 's1' })).toBeNull();
    expect(normalize({ hook_event_name: 'pre_tool_call', session_id: 's1' })).toBeNull();
    expect(
      normalize({ hook_event_name: 'subagent_start', session_id: 's1', extra: {} }),
    ).toBeNull();
  });
});
