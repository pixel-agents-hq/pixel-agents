import { describe, expect, it } from 'vitest';

import { claudeProvider } from '../src/providers/hook/claude/claude.js';

describe('claudeProvider', () => {
  describe('identity', () => {
    it('has kind "hook"', () => {
      expect(claudeProvider.kind).toBe('hook');
    });
    it('has id "claude"', () => {
      expect(claudeProvider.id).toBe('claude');
    });
    it('has a displayName', () => {
      expect(claudeProvider.displayName).toBe('Claude Code');
    });
    it('has Task and Agent in subagentToolNames', () => {
      expect(claudeProvider.subagentToolNames.has('Task')).toBe(true);
      expect(claudeProvider.subagentToolNames.has('Agent')).toBe(true);
    });
    it('has reading tools Read/Grep/Glob/WebFetch/WebSearch', () => {
      for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']) {
        expect(claudeProvider.readingTools.has(tool)).toBe(true);
      }
      expect(claudeProvider.readingTools.has('Edit')).toBe(false);
    });
    it('has protocolVersion 1', () => {
      expect(claudeProvider.protocolVersion).toBe(1);
    });
    it('has a linked TeamProvider', () => {
      expect(claudeProvider.team).toBeDefined();
      expect(claudeProvider.team?.providerId).toBe('claude');
    });
  });

  describe('normalizeHookEvent', () => {
    it('returns null when hook_event_name is missing', () => {
      expect(claudeProvider.normalizeHookEvent({ session_id: 'x' })).toBeNull();
    });
    it('returns null when session_id is missing', () => {
      expect(claudeProvider.normalizeHookEvent({ hook_event_name: 'Stop' })).toBeNull();
    });
    it('returns null for unknown hook event names', () => {
      expect(
        claudeProvider.normalizeHookEvent({
          hook_event_name: 'SomethingWeird',
          session_id: 'x',
        }),
      ).toBeNull();
    });

    it('normalizes PreToolUse with tool_name + tool_input', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Read',
        tool_input: { file_path: '/foo.ts' },
      });
      expect(result?.sessionId).toBe('sess-1');
      expect(result?.event.kind).toBe('toolStart');
      if (result?.event.kind === 'toolStart') {
        expect(result.event.toolName).toBe('Read');
        expect(result.event.toolId.startsWith('hook-')).toBe(true);
        expect(result.event.input).toEqual({ file_path: '/foo.ts' });
        expect(result.event.runInBackground).toBe(false);
      }
    });

    it('PreToolUse sets runInBackground when tool_input.run_in_background=true', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Agent',
        tool_input: { run_in_background: true },
      });
      if (result?.event.kind === 'toolStart') {
        expect(result.event.runInBackground).toBe(true);
      } else {
        expect.fail('expected toolStart');
      }
    });

    it('normalizes PostToolUse to toolEnd with sentinel toolId', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'PostToolUse',
        session_id: 'sess-1',
      });
      expect(result?.event.kind).toBe('toolEnd');
    });

    it('normalizes PostToolUseFailure to toolEnd (same as PostToolUse)', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'PostToolUseFailure',
        session_id: 'sess-1',
      });
      expect(result?.event.kind).toBe('toolEnd');
    });

    it('normalizes Stop to turnEnd', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'Stop',
        session_id: 'sess-1',
      });
      expect(result?.event.kind).toBe('turnEnd');
    });

    it('ignores UserPromptSubmit (no normalized kind yet)', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-1',
      });
      expect(result).toBeNull();
    });

    it('normalizes SubagentStart with agent_type as toolName', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'SubagentStart',
        session_id: 'sess-1',
        agent_type: 'web-researcher',
      });
      expect(result?.event.kind).toBe('subagentStart');
      if (result?.event.kind === 'subagentStart') {
        expect(result.event.toolName).toBe('web-researcher');
        expect(result.event.toolId.startsWith('hook-sub-web-researcher-')).toBe(true);
      }
    });

    it('normalizes SubagentStop to subagentEnd', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'SubagentStop',
        session_id: 'sess-1',
      });
      expect(result?.event.kind).toBe('subagentEnd');
    });

    it('normalizes PermissionRequest to permissionRequest', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'PermissionRequest',
        session_id: 'sess-1',
      });
      expect(result?.event.kind).toBe('permissionRequest');
    });

    it('normalizes Notification(permission_prompt) to permissionRequest', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'Notification',
        session_id: 'sess-1',
        notification_type: 'permission_prompt',
      });
      expect(result?.event.kind).toBe('permissionRequest');
    });

    it('normalizes Notification(idle_prompt) to turnEnd', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'Notification',
        session_id: 'sess-1',
        notification_type: 'idle_prompt',
      });
      expect(result?.event.kind).toBe('turnEnd');
    });

    it('returns null for Notification with unknown type', () => {
      expect(
        claudeProvider.normalizeHookEvent({
          hook_event_name: 'Notification',
          session_id: 'sess-1',
          notification_type: 'other',
        }),
      ).toBeNull();
    });

    it('normalizes SessionStart with source + transcript_path + cwd', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'SessionStart',
        session_id: 'sess-1',
        source: 'startup',
        transcript_path: '/Users/x/.claude/projects/foo/sess-1.jsonl',
        cwd: '/Users/x/work',
      });
      expect(result?.event.kind).toBe('sessionStart');
      if (result?.event.kind === 'sessionStart') {
        expect(result.event.source).toBe('startup');
        expect(result.event.transcriptPath).toBe('/Users/x/.claude/projects/foo/sess-1.jsonl');
        expect(result.event.cwd).toBe('/Users/x/work');
      }
    });

    it('normalizes SessionEnd with reason', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'SessionEnd',
        session_id: 'sess-1',
        reason: 'clear',
      });
      expect(result?.event.kind).toBe('sessionEnd');
      if (result?.event.kind === 'sessionEnd') {
        expect(result.event.reason).toBe('clear');
      }
    });

    it('normalizes TeammateIdle to subagentTurnEnd with reason=idle', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'TeammateIdle',
        session_id: 'sess-1',
        agent_type: 'web-researcher',
      });
      expect(result?.event.kind).toBe('subagentTurnEnd');
      if (result?.event.kind === 'subagentTurnEnd') {
        expect(result.event.reason).toBe('idle');
      }
    });

    it('normalizes TaskCompleted to subagentTurnEnd with reason=completed', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'TaskCompleted',
        session_id: 'sess-1',
        subject: 'Code review',
      });
      expect(result?.event.kind).toBe('subagentTurnEnd');
      if (result?.event.kind === 'subagentTurnEnd') {
        expect(result.event.reason).toBe('completed');
      }
    });

    it('returns null for TaskCreated (informational only)', () => {
      expect(
        claudeProvider.normalizeHookEvent({
          hook_event_name: 'TaskCreated',
          session_id: 'sess-1',
          subject: 'Code review',
        }),
      ).toBeNull();
    });
  });

  describe('formatToolStatus', () => {
    it('formats Read', () => {
      expect(claudeProvider.formatToolStatus('Read', { file_path: '/a/b.ts' })).toBe(
        'Reading b.ts',
      );
    });
    it('formats Task/Agent with description', () => {
      expect(claudeProvider.formatToolStatus('Task', { description: 'Code review' })).toBe(
        'Subtask: Code review',
      );
      expect(claudeProvider.formatToolStatus('Agent', { description: 'Research' })).toBe(
        'Subtask: Research',
      );
    });
    it('falls back to "Using X" for unknown tools', () => {
      expect(claudeProvider.formatToolStatus('FancyTool', {})).toBe('Using FancyTool');
    });
    it('handles undefined input', () => {
      expect(claudeProvider.formatToolStatus('Read', undefined)).toBe('Reading ');
    });
  });
});
