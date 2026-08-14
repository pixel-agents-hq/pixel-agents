import { describe, expect, it } from 'vitest';

import { webProvider } from '../src/providers/hook/web/web.js';

describe('webProvider', () => {
  describe('identity', () => {
    it('has kind "hook"', () => {
      expect(webProvider.kind).toBe('hook');
    });
    it('has id "web"', () => {
      expect(webProvider.id).toBe('web');
    });
    it('has a displayName', () => {
      expect(webProvider.displayName).toBe('Web (REST)');
    });
    it('has protocolVersion 1', () => {
      expect(webProvider.protocolVersion).toBe(1);
    });
    it('has no team extension', () => {
      expect(webProvider.team).toBeUndefined();
    });
    it('has no file-fallback members', () => {
      expect(webProvider.getSessionDirs).toBeUndefined();
      expect(webProvider.getAllSessionRoots).toBeUndefined();
      expect(webProvider.sessionFilePattern).toBeUndefined();
      expect(webProvider.parseTranscriptLine).toBeUndefined();
      expect(webProvider.buildLaunchCommand).toBeUndefined();
      expect(webProvider.terminalNamePrefix).toBeUndefined();
    });
    it('has empty (free-form) tool vocabulary sets', () => {
      expect(webProvider.readingTools.size).toBe(0);
      expect(webProvider.subagentToolNames.size).toBe(0);
      expect(webProvider.permissionExemptTools.size).toBe(0);
    });
  });

  describe('installHooks/uninstallHooks/areHooksInstalled', () => {
    it('installHooks resolves (no-op)', async () => {
      await expect(webProvider.installHooks('http://x', 'token')).resolves.toBeUndefined();
    });
    it('uninstallHooks resolves (no-op)', async () => {
      await expect(webProvider.uninstallHooks()).resolves.toBeUndefined();
    });
    it('areHooksInstalled always resolves true', async () => {
      await expect(webProvider.areHooksInstalled()).resolves.toBe(true);
    });
  });

  describe('formatToolStatus', () => {
    it('falls back to "Using <toolName>" with no override', () => {
      expect(webProvider.formatToolStatus('custom-linter')).toBe('Using custom-linter');
    });
    it('prefers a caller-supplied status override carried in input', () => {
      const { event } = webProvider.normalizeHookEvent({
        hook_event_name: 'toolStart',
        session_id: 's1',
        tool_id: 't1',
        tool_name: 'custom-linter',
        status: 'Linting src/',
      })!;
      expect(event.kind).toBe('toolStart');
      if (event.kind === 'toolStart') {
        expect(webProvider.formatToolStatus(event.toolName, event.input)).toBe('Linting src/');
      }
    });
  });

  describe('normalizeHookEvent', () => {
    it('returns null when hook_event_name is missing', () => {
      expect(webProvider.normalizeHookEvent({ session_id: 'x' })).toBeNull();
    });
    it('returns null when session_id is missing', () => {
      expect(webProvider.normalizeHookEvent({ hook_event_name: 'sessionStart' })).toBeNull();
    });
    it('returns null for unknown hook event names', () => {
      expect(
        webProvider.normalizeHookEvent({ hook_event_name: 'somethingWeird', session_id: 'x' }),
      ).toBeNull();
    });
    it('returns null for subagentTurnEnd (no web-provider equivalent)', () => {
      expect(
        webProvider.normalizeHookEvent({ hook_event_name: 'subagentTurnEnd', session_id: 'x' }),
      ).toBeNull();
    });
    it('returns null for progress (JSONL-only, not hook-driven for any provider)', () => {
      expect(
        webProvider.normalizeHookEvent({ hook_event_name: 'progress', session_id: 'x' }),
      ).toBeNull();
    });

    it('normalizes sessionStart with cwd, no transcriptPath', () => {
      const result = webProvider.normalizeHookEvent({
        hook_event_name: 'sessionStart',
        session_id: 'sess-1',
        cwd: '/path/to/project',
      });
      expect(result?.sessionId).toBe('sess-1');
      expect(result?.event).toEqual({
        kind: 'sessionStart',
        source: undefined,
        transcriptPath: undefined,
        cwd: '/path/to/project',
      });
    });

    it('normalizes sessionEnd with optional reason', () => {
      const result = webProvider.normalizeHookEvent({
        hook_event_name: 'sessionEnd',
        session_id: 'sess-1',
        reason: 'exit',
      });
      expect(result?.event).toEqual({ kind: 'sessionEnd', reason: 'exit' });
    });

    it('normalizes toolStart with toolId + toolName + input', () => {
      const result = webProvider.normalizeHookEvent({
        hook_event_name: 'toolStart',
        session_id: 'sess-1',
        tool_id: 't1',
        tool_name: 'Build',
        input: { target: 'release' },
      });
      expect(result?.event.kind).toBe('toolStart');
      if (result?.event.kind === 'toolStart') {
        expect(result.event.toolId).toBe('t1');
        expect(result.event.toolName).toBe('Build');
        expect((result.event.input as Record<string, unknown>).target).toBe('release');
      }
    });
    it('returns null for toolStart missing tool_id or tool_name', () => {
      expect(
        webProvider.normalizeHookEvent({
          hook_event_name: 'toolStart',
          session_id: 'sess-1',
          tool_name: 'Build',
        }),
      ).toBeNull();
      expect(
        webProvider.normalizeHookEvent({
          hook_event_name: 'toolStart',
          session_id: 'sess-1',
          tool_id: 't1',
        }),
      ).toBeNull();
    });

    it('normalizes toolEnd with toolId', () => {
      const result = webProvider.normalizeHookEvent({
        hook_event_name: 'toolEnd',
        session_id: 'sess-1',
        tool_id: 't1',
      });
      expect(result?.event).toEqual({ kind: 'toolEnd', toolId: 't1' });
    });
    it('returns null for toolEnd missing tool_id', () => {
      expect(
        webProvider.normalizeHookEvent({ hook_event_name: 'toolEnd', session_id: 'sess-1' }),
      ).toBeNull();
    });

    it('normalizes turnEnd, defaulting awaitingInput to false', () => {
      const result = webProvider.normalizeHookEvent({
        hook_event_name: 'turnEnd',
        session_id: 'sess-1',
      });
      expect(result?.event).toEqual({ kind: 'turnEnd', awaitingInput: false });
    });
    it('normalizes turnEnd with awaiting_input=true', () => {
      const result = webProvider.normalizeHookEvent({
        hook_event_name: 'turnEnd',
        session_id: 'sess-1',
        awaiting_input: true,
      });
      expect(result?.event).toEqual({ kind: 'turnEnd', awaitingInput: true });
    });

    it('normalizes permissionRequest', () => {
      const result = webProvider.normalizeHookEvent({
        hook_event_name: 'permissionRequest',
        session_id: 'sess-1',
      });
      expect(result?.event).toEqual({ kind: 'permissionRequest' });
    });

    it('normalizes subagentStart with parentToolId + toolId + toolName', () => {
      const result = webProvider.normalizeHookEvent({
        hook_event_name: 'subagentStart',
        session_id: 'sess-1',
        parent_tool_id: 'p1',
        tool_id: 't1',
        tool_name: 'Worker',
      });
      expect(result?.event.kind).toBe('subagentStart');
      if (result?.event.kind === 'subagentStart') {
        expect(result.event.parentToolId).toBe('p1');
        expect(result.event.toolId).toBe('t1');
        expect(result.event.toolName).toBe('Worker');
      }
    });
    it('returns null for subagentStart missing required fields', () => {
      expect(
        webProvider.normalizeHookEvent({
          hook_event_name: 'subagentStart',
          session_id: 'sess-1',
          tool_id: 't1',
          tool_name: 'Worker',
        }),
      ).toBeNull();
    });

    it('normalizes subagentEnd with parentToolId + toolId', () => {
      const result = webProvider.normalizeHookEvent({
        hook_event_name: 'subagentEnd',
        session_id: 'sess-1',
        parent_tool_id: 'p1',
        tool_id: 't1',
      });
      expect(result?.event).toEqual({ kind: 'subagentEnd', parentToolId: 'p1', toolId: 't1' });
    });
    it('returns null for subagentEnd missing required fields', () => {
      expect(
        webProvider.normalizeHookEvent({
          hook_event_name: 'subagentEnd',
          session_id: 'sess-1',
          parent_tool_id: 'p1',
        }),
      ).toBeNull();
    });
  });
});
