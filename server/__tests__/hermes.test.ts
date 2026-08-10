import { describe, expect, it } from 'vitest';

import { hermesProvider } from '../src/providers/hook/hermes/hermes.js';

describe('hermesProvider', () => {
  describe('identity', () => {
    it('has kind "hook"', () => {
      expect(hermesProvider.kind).toBe('hook');
    });
    it('has id "hermes"', () => {
      expect(hermesProvider.id).toBe('hermes');
    });
    it('has a displayName', () => {
      expect(hermesProvider.displayName).toBe('Hermes Agent');
    });
    it('has protocolVersion 1', () => {
      expect(hermesProvider.protocolVersion).toBe(1);
    });
  });

  describe('normalizeHookEvent', () => {
    it('returns null when hook_event_name is missing', () => {
      expect(hermesProvider.normalizeHookEvent({ session_id: 'x' })).toBeNull();
    });
    it('returns null when session_id is missing', () => {
      expect(hermesProvider.normalizeHookEvent({ hook_event_name: 'SessionStart' })).toBeNull();
    });
    it('returns null for an unknown event name (forward-compat, never throws)', () => {
      expect(
        hermesProvider.normalizeHookEvent({
          hook_event_name: 'FutureHermesEvent',
          session_id: 's1',
        }),
      ).toBeNull();
    });

    it('maps SessionStart -> sessionStart', () => {
      const result = hermesProvider.normalizeHookEvent({
        hook_event_name: 'SessionStart',
        session_id: 's1',
        cwd: '/home/user/project',
      });
      expect(result?.event).toEqual({ kind: 'sessionStart', cwd: '/home/user/project' });
    });

    it('maps SessionEnd (on_session_finalize) -> sessionEnd', () => {
      const result = hermesProvider.normalizeHookEvent({
        hook_event_name: 'SessionEnd',
        session_id: 's1',
        reason: 'finalize',
      });
      expect(result?.event).toEqual({ kind: 'sessionEnd', reason: 'finalize' });
    });

    it('maps TurnEnd (on_session_end, which fires per-turn in Hermes) -> turnEnd', () => {
      const result = hermesProvider.normalizeHookEvent({
        hook_event_name: 'TurnEnd',
        session_id: 's1',
        awaiting_input: true,
      });
      expect(result?.event).toEqual({ kind: 'turnEnd', awaitingInput: true });
    });

    it('TurnEnd defaults awaitingInput to false when not interrupted', () => {
      const result = hermesProvider.normalizeHookEvent({
        hook_event_name: 'TurnEnd',
        session_id: 's1',
      });
      expect(result?.event).toEqual({ kind: 'turnEnd', awaitingInput: false });
    });

    it('maps ExecStart (pre_tool_call) -> toolStart', () => {
      const result = hermesProvider.normalizeHookEvent({
        hook_event_name: 'ExecStart',
        session_id: 's1',
        tool_id: 'call_1',
        tool_name: 'terminal',
        tool_input: { command: 'echo hi' },
      });
      expect(result?.event).toEqual({
        kind: 'toolStart',
        toolId: 'call_1',
        toolName: 'terminal',
        input: { command: 'echo hi' },
      });
    });

    it('maps ExecEnd (post_tool_call) -> toolEnd', () => {
      const result = hermesProvider.normalizeHookEvent({
        hook_event_name: 'ExecEnd',
        session_id: 's1',
        tool_id: 'call_1',
      });
      expect(result?.event).toEqual({ kind: 'toolEnd', toolId: 'call_1' });
    });

    it('maps SubagentStart -> subagentStart keyed by child_session_id', () => {
      const result = hermesProvider.normalizeHookEvent({
        hook_event_name: 'SubagentStart',
        session_id: 'lead-1',
        child_session_id: 'child-1',
        agent_type: 'researcher',
        goal: 'find docs',
      });
      expect(result).toEqual({
        sessionId: 'lead-1',
        event: {
          kind: 'subagentStart',
          parentToolId: 'current',
          toolId: 'child-1',
          toolName: 'researcher',
          input: 'find docs',
        },
      });
    });

    it('maps SubagentStop -> subagentEnd keyed by the same child_session_id', () => {
      const result = hermesProvider.normalizeHookEvent({
        hook_event_name: 'SubagentStop',
        session_id: 'lead-1',
        child_session_id: 'child-1',
      });
      expect(result).toEqual({
        sessionId: 'lead-1',
        event: { kind: 'subagentEnd', parentToolId: 'current', toolId: 'child-1' },
      });
    });
  });

  describe('formatToolStatus', () => {
    it('formats terminal/run_command/shell with the command text', () => {
      expect(hermesProvider.formatToolStatus('terminal', { command: 'ls' })).toBe('Running: ls');
    });
    it('formats mcp__ prefixed tools using the server-local name', () => {
      expect(hermesProvider.formatToolStatus('mcp__supabase__list_tables')).toBe(
        'Using list_tables',
      );
    });
    it('falls back to the raw tool name for unrecognized tools', () => {
      expect(hermesProvider.formatToolStatus('some_future_tool')).toBe('Using some_future_tool');
    });
  });
});
