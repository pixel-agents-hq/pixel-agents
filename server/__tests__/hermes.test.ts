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
      expect(hermesProvider.displayName).toBe('Hermes');
    });
    it('has delegate_task in subagentToolNames', () => {
      expect(hermesProvider.subagentToolNames.has('delegate_task')).toBe(true);
    });
    it('has reading tools read_file/search_files/web_search/web_extract', () => {
      for (const tool of ['read_file', 'search_files', 'web_search', 'web_extract']) {
        expect(hermesProvider.readingTools.has(tool)).toBe(true);
      }
      expect(hermesProvider.readingTools.has('terminal')).toBe(false);
      expect(hermesProvider.readingTools.has('patch')).toBe(false);
    });
    it('has protocolVersion 1', () => {
      expect(hermesProvider.protocolVersion).toBe(1);
    });
    it('has a terminalNamePrefix', () => {
      expect(hermesProvider.terminalNamePrefix).toBe('Hermes');
    });
    it('has no TeamProvider (Hermes subagents are plain delegate_task runs)', () => {
      expect(hermesProvider.team).toBeUndefined();
    });
    it('has no file-fallback surface (Hermes sessions are SQLite, not JSONL)', () => {
      expect(hermesProvider.getSessionDirs).toBeUndefined();
      expect(hermesProvider.getAllSessionRoots).toBeUndefined();
      expect(hermesProvider.sessionFilePattern).toBeUndefined();
    });
  });

  describe('normalizeHookEvent', () => {
    it('returns null when hook_event_name is missing', () => {
      expect(hermesProvider.normalizeHookEvent({ session_id: 'x' })).toBeNull();
    });
    it('returns null when session_id is missing', () => {
      expect(hermesProvider.normalizeHookEvent({ hook_event_name: 'pre_tool_call' })).toBeNull();
    });
    it('returns null for unknown hook event names', () => {
      expect(
        hermesProvider.normalizeHookEvent({
          hook_event_name: 'SomethingWeird',
          session_id: 'x',
        }),
      ).toBeNull();
    });

    it('normalizes pre_tool_call with tool_name + tool_input', () => {
      const result = hermesProvider.normalizeHookEvent({
        hook_event_name: 'pre_tool_call',
        session_id: 'sess-1',
        tool_name: 'read_file',
        tool_input: { path: '/foo.ts' },
        cwd: '/home/user/project',
      });
      expect(result?.sessionId).toBe('sess-1');
      expect(result?.event.kind).toBe('toolStart');
      if (result?.event.kind === 'toolStart') {
        expect(result.event.toolName).toBe('read_file');
        expect(result.event.toolId.startsWith('hook-')).toBe(true);
        expect(result.event.input).toEqual({ path: '/foo.ts' });
      }
    });

    it('pre_tool_call tolerates missing tool_input', () => {
      const result = hermesProvider.normalizeHookEvent({
        hook_event_name: 'pre_tool_call',
        session_id: 'sess-1',
        tool_name: 'terminal',
      });
      expect(result?.event.kind).toBe('toolStart');
      if (result?.event.kind === 'toolStart') {
        expect(result.event.input).toEqual({});
      }
    });

    it('normalizes post_tool_call to toolEnd with sentinel toolId', () => {
      const result = hermesProvider.normalizeHookEvent({
        hook_event_name: 'post_tool_call',
        session_id: 'sess-1',
        tool_name: 'terminal',
        extra: { status: 'ok', duration_ms: 42 },
      });
      expect(result?.event.kind).toBe('toolEnd');
    });

    it('normalizes on_turn_complete to turnEnd with awaitingInput=true', () => {
      const result = hermesProvider.normalizeHookEvent({
        hook_event_name: 'on_turn_complete',
        session_id: 'sess-1',
      });
      expect(result?.event.kind).toBe('turnEnd');
      if (result?.event.kind === 'turnEnd') {
        expect(result.event.awaitingInput).toBe(true);
      }
    });

    it('normalizes on_session_start with cwd and platform source', () => {
      const result = hermesProvider.normalizeHookEvent({
        hook_event_name: 'on_session_start',
        session_id: 'sess-1',
        cwd: '/Users/x/work',
        extra: { model: 'deepseek-v4-flash', platform: 'cli' },
      });
      expect(result?.event.kind).toBe('sessionStart');
      if (result?.event.kind === 'sessionStart') {
        expect(result.event.source).toBe('cli');
        expect(result.event.cwd).toBe('/Users/x/work');
        expect(result.event.transcriptPath).toBeUndefined();
      }
    });

    it('normalizes on_session_end with reason=completed from extra', () => {
      const result = hermesProvider.normalizeHookEvent({
        hook_event_name: 'on_session_end',
        session_id: 'sess-1',
        extra: { completed: true, interrupted: false, model: 'deepseek-v4-flash' },
      });
      expect(result?.event.kind).toBe('sessionEnd');
      if (result?.event.kind === 'sessionEnd') {
        expect(result.event.reason).toBe('completed');
      }
    });

    it('normalizes on_session_end with reason=interrupted when interrupted', () => {
      const result = hermesProvider.normalizeHookEvent({
        hook_event_name: 'on_session_end',
        session_id: 'sess-1',
        extra: { completed: false, interrupted: true },
      });
      expect(result?.event.kind).toBe('sessionEnd');
      if (result?.event.kind === 'sessionEnd') {
        expect(result.event.reason).toBe('interrupted');
      }
    });

    it('normalizes subagent_start with child_role as toolName', () => {
      const result = hermesProvider.normalizeHookEvent({
        hook_event_name: 'subagent_start',
        session_id: 'sess-1',
        extra: {
          child_role: 'leaf',
          child_session_id: 'sess-child',
          child_goal: 'Review the diff',
        },
      });
      expect(result?.event.kind).toBe('subagentStart');
      if (result?.event.kind === 'subagentStart') {
        expect(result.event.toolName).toBe('leaf');
        expect(result.event.parentToolId).toBe('current');
        expect(result.event.toolId.startsWith('hook-sub-leaf-')).toBe(true);
      }
    });

    it('normalizes subagent_stop to subagentEnd', () => {
      const result = hermesProvider.normalizeHookEvent({
        hook_event_name: 'subagent_stop',
        session_id: 'sess-1',
        extra: { child_role: 'leaf', child_status: 'success' },
      });
      expect(result?.event.kind).toBe('subagentEnd');
    });

    it('drops gateway_platform_event (no AgentEvent shape fits)', () => {
      expect(
        hermesProvider.normalizeHookEvent({
          hook_event_name: 'gateway_platform_event',
          session_id: 'sess-1',
          extra: { platform: 'telegram', event_type: 'reaction' },
        }),
      ).toBeNull();
    });

    it('drops on_session_finalize (sessionEnd already removes the agent)', () => {
      expect(
        hermesProvider.normalizeHookEvent({
          hook_event_name: 'on_session_finalize',
          session_id: 'sess-1',
        }),
      ).toBeNull();
    });
  });

  describe('formatToolStatus', () => {
    it('formats terminal with command', () => {
      expect(hermesProvider.formatToolStatus('terminal', { command: 'npm test' })).toBe(
        'Running: npm test',
      );
    });
    it('formats read_file', () => {
      expect(hermesProvider.formatToolStatus('read_file', { path: '/a/b.ts' })).toBe(
        'Reading b.ts',
      );
    });
    it('formats write_file', () => {
      expect(hermesProvider.formatToolStatus('write_file', { path: '/a/c.ts' })).toBe(
        'Writing c.ts',
      );
    });
    it('formats patch with a single path', () => {
      expect(hermesProvider.formatToolStatus('patch', { path: '/a/d.ts' })).toBe('Editing d.ts');
    });
    it('formats patch with a multi-file V4A path array', () => {
      expect(hermesProvider.formatToolStatus('patch', { path: ['/a/one.ts', '/a/two.ts'] })).toBe(
        'Editing one.ts, two.ts',
      );
    });
    it('formats search_files / web_search / web_extract', () => {
      expect(hermesProvider.formatToolStatus('search_files')).toBe('Searching files');
      expect(hermesProvider.formatToolStatus('web_search')).toBe('Searching the web');
      expect(hermesProvider.formatToolStatus('web_extract')).toBe('Extracting web content');
    });
    it('formats execute_code / browser_exec / computer_use', () => {
      expect(hermesProvider.formatToolStatus('execute_code')).toBe('Running code');
      expect(hermesProvider.formatToolStatus('browser_exec')).toBe('Browsing the web');
      expect(hermesProvider.formatToolStatus('computer_use')).toBe('Controlling the computer');
    });
    it('formats delegate_task with goal', () => {
      expect(hermesProvider.formatToolStatus('delegate_task', { goal: 'Research X' })).toBe(
        'Subtask: Research X',
      );
      expect(hermesProvider.formatToolStatus('delegate_task')).toBe('Running subtask');
    });
    it('formats skill_view with name', () => {
      expect(hermesProvider.formatToolStatus('skill_view', { name: 'github-pr-workflow' })).toBe(
        'Loading skill: github-pr-workflow',
      );
    });
    it('falls back to "Using X" for unknown tools', () => {
      expect(hermesProvider.formatToolStatus('FancyTool', {})).toBe('Using FancyTool');
    });
    it('handles undefined input', () => {
      expect(hermesProvider.formatToolStatus('read_file', undefined)).toBe('Reading ');
    });
  });

  describe('contextWindowForModel', () => {
    it('returns small window for flash/mini models', () => {
      expect(hermesProvider.contextWindowForModel?.('deepseek-v4-flash')).toBe(128_000);
      expect(hermesProvider.contextWindowForModel?.('gpt-4o-mini')).toBe(128_000);
    });
    it('returns large window for recognized large models', () => {
      expect(hermesProvider.contextWindowForModel?.('claude-sonnet-5')).toBe(200_000);
    });
    it('returns undefined for unknown/synthetic models', () => {
      expect(hermesProvider.contextWindowForModel?.('<synthetic>')).toBeUndefined();
      expect(hermesProvider.contextWindowForModel?.(undefined)).toBeUndefined();
    });
  });
});
