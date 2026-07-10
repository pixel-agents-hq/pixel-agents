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
      expect(codexProvider.displayName).toBe('Codex');
    });
    it('has protocolVersion 1', () => {
      expect(codexProvider.protocolVersion).toBe(1);
    });
    it('has no team, subagent, or reading-tool concept', () => {
      expect(codexProvider.team).toBeUndefined();
      expect(codexProvider.subagentToolNames.size).toBe(0);
      expect(codexProvider.readingTools.size).toBe(0);
    });
  });

  describe('normalizeHookEvent', () => {
    it('returns null when hook_event_name is missing', () => {
      expect(codexProvider.normalizeHookEvent({ session_id: 'x' })).toBeNull();
    });
    it('returns null when session_id is missing', () => {
      expect(codexProvider.normalizeHookEvent({ hook_event_name: 'Stop' })).toBeNull();
    });
    it('returns null for unknown hook event names', () => {
      expect(
        codexProvider.normalizeHookEvent({
          hook_event_name: 'SomethingWeird',
          session_id: 'x',
        }),
      ).toBeNull();
    });
    it('returns null for UserPromptSubmit (no normalized kind yet)', () => {
      expect(
        codexProvider.normalizeHookEvent({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'sess-1',
        }),
      ).toBeNull();
    });

    it('normalizes SessionStart with source + cwd', () => {
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: 'SessionStart',
        session_id: 'sess-1',
        source: 'startup',
        cwd: '/home/user/project',
      });
      expect(result?.sessionId).toBe('sess-1');
      expect(result?.event).toEqual({
        kind: 'sessionStart',
        source: 'startup',
        cwd: '/home/user/project',
      });
    });

    it('normalizes PreToolUse (Bash-only) into toolStart', () => {
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
      });
      expect(result?.sessionId).toBe('sess-1');
      expect(result?.event.kind).toBe('toolStart');
      if (result?.event.kind === 'toolStart') {
        expect(result.event.toolName).toBe('Bash');
        expect(result.event.input).toEqual({ command: 'npm test' });
      }
    });

    it('normalizes PostToolUse into toolEnd', () => {
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: 'PostToolUse',
        session_id: 'sess-1',
      });
      expect(result?.event).toEqual({ kind: 'toolEnd', toolId: 'current' });
    });

    it('normalizes Stop into turnEnd', () => {
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: 'Stop',
        session_id: 'sess-1',
      });
      expect(result?.event).toEqual({ kind: 'turnEnd' });
    });
  });

  describe('formatToolStatus', () => {
    it('formats Bash commands the same way Claude does', () => {
      expect(codexProvider.formatToolStatus('Bash', { command: 'npm test' })).toBe(
        'Running: npm test',
      );
    });
  });
});
