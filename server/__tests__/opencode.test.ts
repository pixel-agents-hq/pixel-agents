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
    it('has protocolVersion 1', () => {
      expect(opencodeProvider.protocolVersion).toBe(1);
    });
    it('has reading tools (read/glob/grep/websearch/webfetch)', () => {
      for (const tool of ['read', 'glob', 'grep', 'websearch', 'webfetch', 'github-repo-info']) {
        expect(opencodeProvider.readingTools.has(tool)).toBe(true);
      }
      expect(opencodeProvider.readingTools.has('write')).toBe(false);
    });
    it('has no file fallback (no sessionFilePattern)', () => {
      expect(opencodeProvider.sessionFilePattern).toBeUndefined();
    });
    it('areHooksInstalled returns true (server is always connected)', async () => {
      await expect(opencodeProvider.areHooksInstalled()).resolves.toBe(true);
    });
  });

  describe('normalizeHookEvent', () => {
    it('returns null when event_type is missing', () => {
      expect(opencodeProvider.normalizeHookEvent({ session_id: 'x' })).toBeNull();
    });
    it('returns null when session_id is missing', () => {
      expect(opencodeProvider.normalizeHookEvent({ event_type: 'session.status' })).toBeNull();
    });
    it('returns null for unknown event types', () => {
      expect(
        opencodeProvider.normalizeHookEvent({
          event_type: 'something.weird',
          session_id: 'x',
        }),
      ).toBeNull();
    });

    it('session.status=busy → sessionStart', () => {
      const result = opencodeProvider.normalizeHookEvent({
        event_type: 'session.status',
        session_id: 'ses-1',
        payload: { status: 'busy' },
      });
      expect(result?.sessionId).toBe('ses-1');
      expect(result?.event.kind).toBe('sessionStart');
    });

    it('session.status=idle → turnEnd', () => {
      const result = opencodeProvider.normalizeHookEvent({
        event_type: 'session.status',
        session_id: 'ses-1',
        payload: { status: 'idle' },
      });
      expect(result?.event.kind).toBe('turnEnd');
    });

    it('session.status=unknown → null', () => {
      expect(
        opencodeProvider.normalizeHookEvent({
          event_type: 'session.status',
          session_id: 'ses-1',
          payload: { status: 'unknown' },
        }),
      ).toBeNull();
    });

    it('message.updated (assistant) → toolStart', () => {
      const result = opencodeProvider.normalizeHookEvent({
        event_type: 'message.updated',
        session_id: 'ses-1',
        payload: { role: 'assistant', message_id: 'msg-1', agent: 'plan' },
      });
      expect(result?.event.kind).toBe('toolStart');
      if (result?.event.kind === 'toolStart') {
        expect(result.event.toolName).toBe('plan');
        expect(result.event.toolId).toBe('msg-1');
      }
    });

    it('message.updated (user) → null (ignored)', () => {
      expect(
        opencodeProvider.normalizeHookEvent({
          event_type: 'message.updated',
          session_id: 'ses-1',
          payload: { role: 'user' },
        }),
      ).toBeNull();
    });

    it('tool.start → toolStart with tool_name + input', () => {
      const result = opencodeProvider.normalizeHookEvent({
        event_type: 'tool.start',
        session_id: 'ses-1',
        payload: { tool_id: 't1', tool_name: 'github-clone-repo', input: { repo: 'escal-ai-platform' } },
      });
      expect(result?.event.kind).toBe('toolStart');
      if (result?.event.kind === 'toolStart') {
        expect(result.event.toolName).toBe('github-clone-repo');
        expect(result.event.toolId).toBe('t1');
        expect(result.event.input).toEqual({ repo: 'escal-ai-platform' });
      }
    });

    it('tool.end → toolEnd', () => {
      const result = opencodeProvider.normalizeHookEvent({
        event_type: 'tool.end',
        session_id: 'ses-1',
        payload: { tool_id: 't1' },
      });
      expect(result?.event.kind).toBe('toolEnd');
    });

    it('session.start → sessionStart with source', () => {
      const result = opencodeProvider.normalizeHookEvent({
        event_type: 'session.start',
        session_id: 'ses-1',
        payload: { source: 'telegram' },
      });
      expect(result?.event.kind).toBe('sessionStart');
      if (result?.event.kind === 'sessionStart') {
        expect(result.event.source).toBe('telegram');
      }
    });

    it('session.end → sessionEnd', () => {
      const result = opencodeProvider.normalizeHookEvent({
        event_type: 'session.end',
        session_id: 'ses-1',
        payload: { reason: 'user-cancelled' },
      });
      expect(result?.event.kind).toBe('sessionEnd');
      if (result?.event.kind === 'sessionEnd') {
        expect(result.event.reason).toBe('user-cancelled');
      }
    });
  });

  describe('formatToolStatus', () => {
    it('formats read', () => {
      expect(opencodeProvider.formatToolStatus('read')).toBe('Reading file');
    });
    it('formats github-clone-repo', () => {
      expect(opencodeProvider.formatToolStatus('github-clone-repo')).toBe('Cloning repository');
    });
    it('formats plane-create-ticket', () => {
      expect(opencodeProvider.formatToolStatus('plane-create-ticket')).toBe('Creating Plane ticket');
    });
    it('falls back to "Using X" for unknown tools', () => {
      expect(opencodeProvider.formatToolStatus('FancyTool')).toBe('Using FancyTool');
    });
  });
});
