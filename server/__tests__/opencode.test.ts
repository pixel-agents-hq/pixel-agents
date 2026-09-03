import { describe, expect, it } from 'vitest';

import { opencodeProvider } from '../src/providers/hook/opencode/opencode.js';

describe('opencodeProvider', () => {
  describe('identity', () => {
    it('has kind "hook"', () => {
      expect(opencodeProvider.kind).toBe('hook');
    });
    it('has id "opencode"', () => {
      expect(opencodeProvider.id).toBe('opencode');
    });
    it('has a displayName', () => {
      expect(opencodeProvider.displayName).toBe('OpenCode');
    });
    it('has task in subagentToolNames', () => {
      expect(opencodeProvider.subagentToolNames.has('task')).toBe(true);
    });
    it('has reading tools read/glob/grep/webfetch/websearch', () => {
      for (const tool of ['read', 'glob', 'grep', 'webfetch', 'websearch']) {
        expect(opencodeProvider.readingTools.has(tool)).toBe(true);
      }
      expect(opencodeProvider.readingTools.has('edit')).toBe(false);
    });
    it('has protocolVersion 1', () => {
      expect(opencodeProvider.protocolVersion).toBe(1);
    });
    it('has no TeamProvider in the MVP', () => {
      expect(opencodeProvider.team).toBeUndefined();
    });
    it('has no file fallback (OpenCode persists sessions in SQLite, not JSONL)', () => {
      expect(opencodeProvider.getSessionDirs).toBeUndefined();
      expect(opencodeProvider.getAllSessionRoots).toBeUndefined();
      expect(opencodeProvider.sessionFilePattern).toBeUndefined();
      expect(opencodeProvider.parseTranscriptLine).toBeUndefined();
    });
  });

  describe('normalizeHookEvent', () => {
    it('returns null when hook_event_name is missing', () => {
      expect(opencodeProvider.normalizeHookEvent({ session_id: 'x' })).toBeNull();
    });
    it('returns null when session_id is missing', () => {
      expect(opencodeProvider.normalizeHookEvent({ hook_event_name: 'Stop' })).toBeNull();
    });
    it('returns null for unknown hook event names', () => {
      expect(
        opencodeProvider.normalizeHookEvent({
          hook_event_name: 'SomethingWeird',
          session_id: 'x',
        }),
      ).toBeNull();
    });

    it('normalizes PreToolUse with tool_name + tool_input + stable call_id toolId', () => {
      const result = opencodeProvider.normalizeHookEvent({
        hook_event_name: 'PreToolUse',
        session_id: 'ses-1',
        tool_name: 'read',
        tool_input: { path: '/foo.ts' },
        call_id: 'call-9',
      });
      expect(result?.sessionId).toBe('ses-1');
      expect(result?.event.kind).toBe('toolStart');
      if (result?.event.kind === 'toolStart') {
        expect(result.event.toolName).toBe('read');
        expect(result.event.toolId).toBe('hook-call-9');
        expect(result.event.input).toEqual({ path: '/foo.ts' });
      }
    });

    it('PreToolUse without call_id falls back to a timestamp toolId', () => {
      const result = opencodeProvider.normalizeHookEvent({
        hook_event_name: 'PreToolUse',
        session_id: 'ses-1',
        tool_name: 'bash',
        tool_input: {},
      });
      if (result?.event.kind === 'toolStart') {
        expect(result.event.toolId.startsWith('hook-')).toBe(true);
      } else {
        expect.fail('expected toolStart');
      }
    });

    it('normalizes PostToolUse and PostToolUseFailure to toolEnd with sentinel toolId', () => {
      for (const name of ['PostToolUse', 'PostToolUseFailure']) {
        const result = opencodeProvider.normalizeHookEvent({
          hook_event_name: name,
          session_id: 'ses-1',
          call_id: 'call-9',
        });
        expect(result?.event.kind).toBe('toolEnd');
      }
    });

    it('normalizes Stop to turnEnd without awaitingInput (Done, not waiting)', () => {
      const result = opencodeProvider.normalizeHookEvent({
        hook_event_name: 'Stop',
        session_id: 'ses-1',
      });
      expect(result?.event.kind).toBe('turnEnd');
      if (result?.event.kind === 'turnEnd') {
        expect(result.event.awaitingInput).toBeFalsy();
      }
    });

    it('normalizes SubagentStart with the subagent type as toolName', () => {
      const result = opencodeProvider.normalizeHookEvent({
        hook_event_name: 'SubagentStart',
        session_id: 'ses-1',
        tool_name: 'explore',
        tool_input: { description: 'Explore auth' },
        call_id: 'call-7',
      });
      expect(result?.event.kind).toBe('subagentStart');
      if (result?.event.kind === 'subagentStart') {
        expect(result.event.toolName).toBe('explore');
        expect(result.event.toolId).toBe('hook-sub-explore-call-7');
        expect(result.event.parentToolId).toBe('hook-call-7');
      }
    });

    it('SubagentStart without call_id degrades to the current sentinel parent', () => {
      const result = opencodeProvider.normalizeHookEvent({
        hook_event_name: 'SubagentStart',
        session_id: 'ses-1',
        tool_name: 'explore',
      });
      if (result?.event.kind === 'subagentStart') {
        expect(result.event.parentToolId).toBe('current');
        expect(result.event.toolId.startsWith('hook-sub-explore-')).toBe(true);
      } else {
        expect.fail('expected subagentStart');
      }
    });

    it('normalizes SubagentStop to subagentEnd', () => {
      const result = opencodeProvider.normalizeHookEvent({
        hook_event_name: 'SubagentStop',
        session_id: 'ses-1',
        call_id: 'call-7',
      });
      expect(result?.event.kind).toBe('subagentEnd');
      if (result?.event.kind === 'subagentEnd') {
        expect(result.event.parentToolId).toBe('hook-call-7');
      }
    });

    it('normalizes PermissionRequest to permissionRequest', () => {
      const result = opencodeProvider.normalizeHookEvent({
        hook_event_name: 'PermissionRequest',
        session_id: 'ses-1',
      });
      expect(result?.event.kind).toBe('permissionRequest');
    });

    it('normalizes SessionStart with source + cwd (no transcriptPath)', () => {
      const result = opencodeProvider.normalizeHookEvent({
        hook_event_name: 'SessionStart',
        session_id: 'ses-1',
        source: 'opencode',
        cwd: '/Users/x/work',
      });
      expect(result?.event.kind).toBe('sessionStart');
      if (result?.event.kind === 'sessionStart') {
        expect(result.event.source).toBe('opencode');
        expect(result.event.transcriptPath).toBeUndefined();
        expect(result.event.cwd).toBe('/Users/x/work');
      }
    });

    it('normalizes SessionEnd with reason', () => {
      const result = opencodeProvider.normalizeHookEvent({
        hook_event_name: 'SessionEnd',
        session_id: 'ses-1',
        reason: 'exit',
      });
      expect(result?.event.kind).toBe('sessionEnd');
      if (result?.event.kind === 'sessionEnd') {
        expect(result.event.reason).toBe('exit');
      }
    });
  });

  describe('formatToolStatus', () => {
    it('formats read/edit/write with basenames', () => {
      expect(opencodeProvider.formatToolStatus('read', { path: '/a/b.ts' })).toBe('Reading b.ts');
      expect(opencodeProvider.formatToolStatus('edit', { filePath: '/a/b.ts' })).toBe(
        'Editing b.ts',
      );
      expect(opencodeProvider.formatToolStatus('write', { filePath: '/a/b.ts' })).toBe(
        'Writing b.ts',
      );
    });
    it('formats bash with the command', () => {
      expect(opencodeProvider.formatToolStatus('bash', { command: 'npm test' })).toBe(
        'Running: npm test',
      );
    });
    it('formats task with description', () => {
      expect(opencodeProvider.formatToolStatus('task', { description: 'Code review' })).toBe(
        'Subtask: Code review',
      );
    });
    it('formats skill/question/todowrite', () => {
      expect(opencodeProvider.formatToolStatus('skill', { name: 'tdd' })).toBe('Using skill tdd');
      expect(opencodeProvider.formatToolStatus('question', {})).toBe('Waiting for your answer');
      expect(opencodeProvider.formatToolStatus('todowrite', {})).toBe('Updating todos');
    });
    it('falls back to "Using X" for unknown tools', () => {
      expect(opencodeProvider.formatToolStatus('fancy', {})).toBe('Using fancy');
    });
    it('handles undefined input', () => {
      expect(opencodeProvider.formatToolStatus('read', undefined)).toBe('Reading ');
    });
  });

  describe('consentDisclosure', () => {
    it('returns a headline plus a three-paragraph disclosure', () => {
      const { headline, disclosure } = opencodeProvider.consentDisclosure();
      expect(headline.length).toBeGreaterThan(0);
      expect(disclosure.split('\n\n')).toHaveLength(3);
    });
  });
});
