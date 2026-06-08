import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { codexProvider } from '../src/providers/hook/codex/codex.js';
import { resolveProvider } from '../src/providers/index.js';

describe('codexProvider', () => {
  afterEach(() => {
    delete process.env.CODEX_HOME;
  });

  describe('identity', () => {
    it('has hook provider identity', () => {
      expect(codexProvider.kind).toBe('hook');
      expect(codexProvider.id).toBe('codex');
      expect(codexProvider.displayName).toBe('Codex');
      expect(codexProvider.protocolVersion).toBe(1);
      expect(codexProvider.team).toBeUndefined();
    });

    it('is resolved by provider registry', () => {
      expect(resolveProvider('codex')).toBe(codexProvider);
      expect(resolveProvider('claude-code').id).toBe('claude');
      expect(resolveProvider('claude').id).toBe('claude');
    });
  });

  describe('session paths and launch command', () => {
    it('uses CODEX_HOME date session dirs', () => {
      process.env.CODEX_HOME = '/tmp/codex-home';
      const dirs = codexProvider.getSessionDirs?.('/workspace') ?? [];
      expect(dirs[0]).toContain(path.join('/tmp', 'codex-home', 'sessions'));
      expect(dirs[0]).toMatch(/\d{4}\/\d{2}\/\d{2}$/);
    });

    it('builds a codex launch command without a synthetic session id flag', () => {
      const launch = codexProvider.buildLaunchCommand?.('synthetic-session', '/workspace');
      expect(launch?.command).toBe('codex');
      expect(launch?.args).not.toContain('--session-id');
      expect(launch?.env?.PWD).toBe('/workspace');
    });

    it('maps bypassPermissions to Codex bypass flag', () => {
      const launch = codexProvider.buildLaunchCommand?.('synthetic-session', '/workspace', {
        bypassPermissions: true,
      });
      expect(launch?.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    });
  });

  describe('normalizeHookEvent', () => {
    it('returns null when required fields are missing', () => {
      expect(codexProvider.normalizeHookEvent({ session_id: 'x' })).toBeNull();
      expect(codexProvider.normalizeHookEvent({ hook_event_name: 'Stop' })).toBeNull();
    });

    it('normalizes PreToolUse with Codex tool_use_id', () => {
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_use_id: 'call-1',
        tool_name: 'exec_command',
        tool_input: { cmd: 'npm test' },
      });
      expect(result?.sessionId).toBe('sess-1');
      expect(result?.event.kind).toBe('toolStart');
      if (result?.event.kind === 'toolStart') {
        expect(result.event.toolId).toBe('call-1');
        expect(result.event.toolName).toBe('exec_command');
        expect(result.event.input).toEqual({ cmd: 'npm test' });
      }
    });

    it('normalizes SessionStart with transcript path and cwd', () => {
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: 'SessionStart',
        session_id: 'sess-1',
        source: 'startup',
        transcript_path: '/tmp/codex/sessions/2026/06/08/rollout.jsonl',
        cwd: '/work/pixel-agents',
      });
      expect(result?.event.kind).toBe('sessionStart');
      if (result?.event.kind === 'sessionStart') {
        expect(result.event.source).toBe('startup');
        expect(result.event.transcriptPath).toBe('/tmp/codex/sessions/2026/06/08/rollout.jsonl');
        expect(result.event.cwd).toBe('/work/pixel-agents');
      }
    });

    it('normalizes Stop and PermissionRequest', () => {
      expect(
        codexProvider.normalizeHookEvent({
          hook_event_name: 'Stop',
          session_id: 'sess-1',
        })?.event.kind,
      ).toBe('turnEnd');
      expect(
        codexProvider.normalizeHookEvent({
          hook_event_name: 'PermissionRequest',
          session_id: 'sess-1',
        })?.event.kind,
      ).toBe('permissionRequest');
    });
  });

  describe('parseTranscriptLine', () => {
    it('parses session_meta cwd', () => {
      const event = codexProvider.parseTranscriptLine?.(
        JSON.stringify({
          type: 'session_meta',
          payload: { cwd: '/work/pixel-agents', source: 'vscode' },
        }),
      );
      expect(event?.kind).toBe('sessionStart');
      if (event?.kind === 'sessionStart') {
        expect(event.cwd).toBe('/work/pixel-agents');
      }
    });

    it('parses function_call and function_call_output', () => {
      const start = codexProvider.parseTranscriptLine?.(
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'call-1',
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: 'npm test' }),
          },
        }),
      );
      expect(start?.kind).toBe('toolStart');
      if (start?.kind === 'toolStart') {
        expect(start.toolId).toBe('call-1');
        expect(start.toolName).toBe('exec_command');
        expect(start.input).toEqual({ cmd: 'npm test' });
      }

      const end = codexProvider.parseTranscriptLine?.(
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'call-1' },
        }),
      );
      expect(end).toEqual({ kind: 'toolEnd', toolId: 'call-1' });
    });

    it('parses task_complete event_msg as turnEnd', () => {
      const event = codexProvider.parseTranscriptLine?.(
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'task_complete' },
        }),
      );
      expect(event).toEqual({ kind: 'turnEnd' });
    });
  });

  describe('formatToolStatus', () => {
    it('formats common Codex tools', () => {
      expect(codexProvider.formatToolStatus('exec_command', { cmd: 'npm test' })).toBe(
        'Running: npm test',
      );
      expect(codexProvider.formatToolStatus('apply_patch', {})).toBe('Editing files');
      expect(codexProvider.formatToolStatus('read_mcp_resource', {})).toBe('Reading resource');
      expect(codexProvider.formatToolStatus('FancyTool', {})).toBe('Using FancyTool');
    });
  });
});
