import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { codexProvider } from '../src/providers/hook/codex/codex.js';
import { resolveProvider } from '../src/providers/index.js';

const EVENT_NAMES = [
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'PermissionRequest',
  'SessionStart',
  'SubagentStart',
  'SubagentStop',
] as const;

function randomString(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-/';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

describe('codexProvider property tests', () => {
  // Feature: codex-agent-support, Property 1: Hook event normalization
  it('normalizeHookEvent maps recognized events or returns null', () => {
    for (let i = 0; i < 100; i++) {
      const eventName = EVENT_NAMES[i % EVENT_NAMES.length];
      const sessionId = `sess-${i}`;
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: eventName,
        session_id: sessionId,
        tool_name: 'exec_command',
        tool_use_id: `call-${i}`,
        tool_input: { cmd: randomString(20) },
        transcript_path: `/tmp/codex/sessions/2026/06/08/rollout-${i}.jsonl`,
        cwd: '/workspace',
      });
      expect(result).not.toBeNull();
      expect(result?.sessionId).toBe(sessionId);
      expect(result?.event.kind).toBeTruthy();

      expect(codexProvider.normalizeHookEvent({ session_id: sessionId })).toBeNull();
      expect(codexProvider.normalizeHookEvent({ hook_event_name: eventName })).toBeNull();
      expect(
        codexProvider.normalizeHookEvent({
          hook_event_name: `unknown-${i}`,
          session_id: sessionId,
        }),
      ).toBeNull();
    }
  });

  // Feature: codex-agent-support, Property 2: formatToolStatus length
  it('formatToolStatus never exceeds 80 characters', () => {
    for (let i = 0; i < 100; i++) {
      const toolName = randomString(5 + (i % 40));
      const input = { cmd: randomString(100), path: randomString(100) };
      const status = codexProvider.formatToolStatus(toolName, input);
      expect(status.length).toBeLessThanOrEqual(80);
    }
  });

  // Feature: codex-agent-support, Property 4: Provider resolution
  it('resolveProvider always returns a valid HookProvider', () => {
    for (let i = 0; i < 100; i++) {
      const value = i % 3 === 0 ? 'codex' : i % 3 === 1 ? 'claude-code' : randomString(12);
      const provider = resolveProvider(value);
      expect(provider).toBeTruthy();
      expect(provider.kind).toBe('hook');
      if (value === 'codex') {
        expect(provider.id).toBe('codex');
      } else if (value === 'claude-code' || value === 'claude') {
        expect(provider.id).toBe('claude');
      } else {
        expect(provider.id).toBe('claude');
      }
    }
  });

  // Feature: codex-agent-support, Property 5: buildLaunchCommand structure
  it('buildLaunchCommand includes bypass flag only when requested', () => {
    for (let i = 0; i < 100; i++) {
      const sessionId = crypto.randomUUID();
      const cwd = `/workspace/${randomString(8)}`;
      const withBypass = i % 2 === 0;
      const launch = codexProvider.buildLaunchCommand?.(sessionId, cwd, {
        bypassPermissions: withBypass,
      });
      expect(launch?.command).toBe('codex');
      expect(Array.isArray(launch?.args)).toBe(true);
      if (withBypass) {
        expect(launch?.args).toContain('--dangerously-bypass-approvals-and-sandbox');
      } else {
        expect(launch?.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      }
    }
  });

  // Feature: codex-agent-support, Property 6: getSessionDirs
  it('getSessionDirs returns home-relative paths without throwing', () => {
    for (let i = 0; i < 100; i++) {
      const workspace = randomString(8 + (i % 20));
      const dirs = codexProvider.getSessionDirs?.(workspace) ?? [];
      expect(dirs.length).toBeGreaterThan(0);
      for (const dir of dirs) {
        expect(dir).toContain(path.join('.codex', 'sessions'));
      }
    }
  });
});
