import { describe, expect, it } from 'vitest';

import { codexProvider } from '../src/providers/hook/codex/codex.js';

describe('codexProvider', () => {
  describe('identity', () => {
    it('has kind "hook"', () => {
      expect(codexProvider.kind).toBe('hook');
    });
    it('has id "codex"', () => {
      expect(codexProvider.id).toBe('codex');
    });
    it('has a displayName', () => {
      expect(codexProvider.displayName).toBe('Codex CLI');
    });
    it('has protocolVersion 1', () => {
      expect(codexProvider.protocolVersion).toBe(1);
    });
    it('has no subagent tools (Codex has no delegation concept today)', () => {
      expect(codexProvider.subagentToolNames.size).toBe(0);
    });
  });

  describe('normalizeHookEvent', () => {
    it('returns null when hook_event_name is missing', () => {
      expect(codexProvider.normalizeHookEvent({ session_id: 'x' })).toBeNull();
    });
    it('returns null when session_id is missing', () => {
      expect(codexProvider.normalizeHookEvent({ hook_event_name: 'SessionStart' })).toBeNull();
    });
    it('returns null for an unknown hook_event_name (forward-compat, never throws)', () => {
      expect(
        codexProvider.normalizeHookEvent({ hook_event_name: 'SomeFutureEvent', session_id: 's1' }),
      ).toBeNull();
    });
    it('maps SessionStart -> sessionStart with cwd/transcriptPath', () => {
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: 'SessionStart',
        session_id: 's1',
        cwd: '/tmp/proj',
        transcript_path: '/home/user/.codex/sessions/2026/01/01/rollout-x.jsonl',
      });
      expect(result).toEqual({
        sessionId: 's1',
        event: {
          kind: 'sessionStart',
          cwd: '/tmp/proj',
          transcriptPath: '/home/user/.codex/sessions/2026/01/01/rollout-x.jsonl',
        },
      });
    });

    it('maps SessionEnd -> sessionEnd with reason', () => {
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: 'SessionEnd',
        session_id: 's1',
        reason: 'idle-timeout',
      });
      expect(result?.event).toEqual({ kind: 'sessionEnd', reason: 'idle-timeout' });
    });

    it('maps ExecStart -> toolStart with toolId/toolName/input', () => {
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: 'ExecStart',
        session_id: 's1',
        tool_id: 'call_abc',
        tool_name: 'exec_command',
        tool_input: { cmd: 'ls' },
      });
      expect(result?.event).toEqual({
        kind: 'toolStart',
        toolId: 'call_abc',
        toolName: 'exec_command',
        input: { cmd: 'ls' },
      });
    });

    it('maps ExecEnd -> toolEnd, keyed by the matching call_id', () => {
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: 'ExecEnd',
        session_id: 's1',
        tool_id: 'call_abc',
      });
      expect(result?.event).toEqual({ kind: 'toolEnd', toolId: 'call_abc' });
    });

    it('ExecEnd falls back to toolId "current" when tool_id is missing', () => {
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: 'ExecEnd',
        session_id: 's1',
      });
      expect(result?.event).toEqual({ kind: 'toolEnd', toolId: 'current' });
    });

    it('maps TurnEnd -> turnEnd (never awaitingInput -- Codex has no distinct idle signal)', () => {
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: 'TurnEnd',
        session_id: 's1',
      });
      expect(result?.event).toEqual({ kind: 'turnEnd' });
    });
  });

  describe('formatToolStatus', () => {
    it('formats exec_command with the command text', () => {
      expect(codexProvider.formatToolStatus('exec_command', { cmd: 'ls -la' })).toBe(
        'Running: ls -la',
      );
    });
    it('classifies apply_patch as a write-style tool (not in readingTools)', () => {
      expect(codexProvider.readingTools.has('apply_patch')).toBe(false);
      expect(codexProvider.formatToolStatus('apply_patch')).toBe('Editing files');
    });
    it('classifies read_file/web_search as reading tools', () => {
      expect(codexProvider.readingTools.has('read_file')).toBe(true);
      expect(codexProvider.readingTools.has('web_search')).toBe(true);
    });
    it('falls back to the raw tool name for unrecognized tools', () => {
      expect(codexProvider.formatToolStatus('some_future_tool')).toBe('Using some_future_tool');
    });
  });
});
