import { describe, expect, it } from 'vitest';

import { cursorProvider } from '../src/providers/hook/cursor/cursor.js';

describe('cursorProvider', () => {
  describe('identity', () => {
    it('has kind hook', () => {
      expect(cursorProvider.kind).toBe('hook');
    });
    it('has id cursor', () => {
      expect(cursorProvider.id).toBe('cursor');
    });
    it('has displayName Cursor', () => {
      expect(cursorProvider.displayName).toBe('Cursor');
    });
    it('has protocolVersion 1', () => {
      expect(cursorProvider.protocolVersion).toBe(1);
    });
    it('has Task in subagent and exempt sets', () => {
      expect(cursorProvider.subagentToolNames.has('Task')).toBe(true);
      expect(cursorProvider.permissionExemptTools.has('Task')).toBe(true);
    });
    it('has reading tools Read/Grep only', () => {
      expect(cursorProvider.readingTools.has('Read')).toBe(true);
      expect(cursorProvider.readingTools.has('Grep')).toBe(true);
      expect(cursorProvider.readingTools.has('Write')).toBe(false);
    });
    it('has no team or unofficial session dirs', () => {
      expect(cursorProvider.team).toBeUndefined();
      expect(cursorProvider.getSessionDirs).toBeUndefined();
      expect(cursorProvider.getAllSessionRoots).toBeUndefined();
    });
  });

  describe('normalizeHookEvent', () => {
    it('returns null when hook_event_name is missing', () => {
      expect(cursorProvider.normalizeHookEvent({ conversation_id: 'x' })).toBeNull();
    });
    it('returns null when both ids are missing', () => {
      expect(cursorProvider.normalizeHookEvent({ hook_event_name: 'stop' })).toBeNull();
    });
    it('accepts conversation_id when session_id is absent', () => {
      const result = cursorProvider.normalizeHookEvent({
        hook_event_name: 'stop',
        conversation_id: 'conv-1',
      });
      expect(result?.sessionId).toBe('conv-1');
      expect(result?.event.kind).toBe('turnEnd');
    });
    it('prefers session_id when both ids are present', () => {
      const result = cursorProvider.normalizeHookEvent({
        hook_event_name: 'stop',
        session_id: 'sess-1',
        conversation_id: 'conv-1',
      });
      expect(result?.sessionId).toBe('sess-1');
    });
    it('returns null for unknown or faked events', () => {
      expect(
        cursorProvider.normalizeHookEvent({
          hook_event_name: 'beforeShellExecution',
          conversation_id: 'x',
        }),
      ).toBeNull();
      expect(
        cursorProvider.normalizeHookEvent({
          hook_event_name: 'PermissionRequest',
          conversation_id: 'x',
        }),
      ).toBeNull();
      expect(
        cursorProvider.normalizeHookEvent({
          hook_event_name: 'Notification',
          conversation_id: 'x',
        }),
      ).toBeNull();
    });

    it('normalizes sessionStart with cwd and real transcript_path', () => {
      const result = cursorProvider.normalizeHookEvent({
        hook_event_name: 'sessionStart',
        conversation_id: 'conv-1',
        composer_mode: 'agent',
        workspace_roots: ['/Users/x/work'],
        transcript_path: '/tmp/real-transcript.jsonl',
      });
      expect(result?.event.kind).toBe('sessionStart');
      if (result?.event.kind === 'sessionStart') {
        expect(result.event.cwd).toBe('/Users/x/work');
        expect(result.event.transcriptPath).toBe('/tmp/real-transcript.jsonl');
        expect(result.event.source).toBe('agent');
      }
    });

    it('omits transcriptPath when Cursor sent null or empty', () => {
      for (const transcript_path of [null, '', undefined]) {
        const result = cursorProvider.normalizeHookEvent({
          hook_event_name: 'sessionStart',
          conversation_id: 'conv-1',
          workspace_roots: ['/Users/x/work'],
          transcript_path,
        });
        if (result?.event.kind === 'sessionStart') {
          expect(result.event.transcriptPath).toBeUndefined();
        } else {
          expect.fail('expected sessionStart');
        }
      }
    });

    it('normalizes sessionEnd with reason', () => {
      const result = cursorProvider.normalizeHookEvent({
        hook_event_name: 'sessionEnd',
        conversation_id: 'conv-1',
        reason: 'user_close',
      });
      expect(result?.event.kind).toBe('sessionEnd');
      if (result?.event.kind === 'sessionEnd') {
        expect(result.event.reason).toBe('user_close');
      }
    });

    it('normalizes preToolUse with tool_use_id as toolId', () => {
      const result = cursorProvider.normalizeHookEvent({
        hook_event_name: 'preToolUse',
        conversation_id: 'conv-1',
        tool_name: 'Shell',
        tool_input: { command: 'ls' },
        tool_use_id: 'tu-9',
      });
      expect(result?.event.kind).toBe('toolStart');
      if (result?.event.kind === 'toolStart') {
        expect(result.event.toolName).toBe('Shell');
        expect(result.event.toolId).toBe('tu-9');
        expect(result.event.input).toEqual({ command: 'ls' });
      }
    });

    it('normalizes postToolUse and postToolUseFailure to toolEnd', () => {
      for (const hook_event_name of ['postToolUse', 'postToolUseFailure']) {
        const result = cursorProvider.normalizeHookEvent({
          hook_event_name,
          conversation_id: 'conv-1',
          tool_use_id: 'tu-9',
        });
        expect(result?.event.kind).toBe('toolEnd');
        if (result?.event.kind === 'toolEnd') {
          expect(result.event.toolId).toBe('tu-9');
        }
      }
    });

    it('normalizes stop to turnEnd', () => {
      const result = cursorProvider.normalizeHookEvent({
        hook_event_name: 'stop',
        conversation_id: 'conv-1',
      });
      expect(result?.event.kind).toBe('turnEnd');
    });

    it('normalizes subagentStart and subagentStop', () => {
      const start = cursorProvider.normalizeHookEvent({
        hook_event_name: 'subagentStart',
        conversation_id: 'conv-1',
        subagent_id: 'sub-1',
        subagent_type: 'explore',
        tool_call_id: 'tc-1',
        is_parallel_worker: true,
      });
      expect(start?.event.kind).toBe('subagentStart');
      if (start?.event.kind === 'subagentStart') {
        expect(start.event.toolId).toBe('sub-1');
        expect(start.event.toolName).toBe('explore');
        expect(start.event.parentToolId).toBe('tc-1');
        expect(start.event.runInBackground).toBe(true);
      }
      const stop = cursorProvider.normalizeHookEvent({
        hook_event_name: 'subagentStop',
        conversation_id: 'conv-1',
        subagent_id: 'sub-1',
      });
      expect(stop?.event.kind).toBe('subagentEnd');
    });
  });

  describe('formatToolStatus', () => {
    it('formats Cursor tool names', () => {
      expect(cursorProvider.formatToolStatus('Read', { path: '/a/b.ts' })).toBe('Reading b.ts');
      expect(cursorProvider.formatToolStatus('Write', { path: '/a/b.ts' })).toBe('Writing b.ts');
      expect(cursorProvider.formatToolStatus('Shell', { command: 'ls' })).toBe('Running: ls');
      expect(cursorProvider.formatToolStatus('Task', { description: 'Explore auth' })).toBe(
        'Subtask: Explore auth',
      );
      expect(cursorProvider.formatToolStatus('FancyTool', {})).toBe('Using FancyTool');
    });
  });
});
