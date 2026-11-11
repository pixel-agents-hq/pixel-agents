import { describe, expect, it } from 'vitest';

import { codexProvider, formatToolStatus } from '../src/providers/hook/codex/codex.js';
import { CODEX_HOOK_EVENTS } from '../src/providers/hook/codex/constants.js';

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
    it('has no TeamProvider (Codex has no Agent Teams equivalent)', () => {
      expect(codexProvider.team).toBeUndefined();
    });
    it('classifies Codex read tools as reading, not typing', () => {
      for (const tool of ['read_file', 'grep', 'file_search', 'list_dir', 'view_image']) {
        expect(codexProvider.readingTools.has(tool)).toBe(true);
      }
      // The two write-side tools must NOT read as reading, or the office shows
      // a character with a book while it edits files.
      expect(codexProvider.readingTools.has('apply_patch')).toBe(false);
      expect(codexProvider.readingTools.has('exec_command')).toBe(false);
    });
    it('exempts non-prompting tools from the permission timer', () => {
      expect(codexProvider.permissionExemptTools.has('update_plan')).toBe(true);
      expect(codexProvider.permissionExemptTools.has('read_file')).toBe(true);
      // exec_command and apply_patch are exactly the tools that DO prompt.
      expect(codexProvider.permissionExemptTools.has('exec_command')).toBe(false);
      expect(codexProvider.permissionExemptTools.has('apply_patch')).toBe(false);
    });
    it('has an empty subagentToolNames (no Task-style tool exists)', () => {
      expect(codexProvider.subagentToolNames.size).toBe(0);
    });
  });

  describe('hook surface', () => {
    it('installs only events the runtime consumes', () => {
      expect([...CODEX_HOOK_EVENTS]).toEqual([
        'SessionStart',
        'SessionEnd',
        'PreToolUse',
        'PostToolUse',
        'PermissionRequest',
        'Stop',
        'SubagentStart',
        'SubagentStop',
      ]);
    });
    it('does NOT install UserPromptSubmit — it would forward prompt text for nothing', () => {
      expect([...CODEX_HOOK_EVENTS]).not.toContain('UserPromptSubmit');
    });
    it('does NOT install compaction or Interrupt events', () => {
      for (const e of ['PreCompact', 'PostCompact', 'Interrupt']) {
        expect([...CODEX_HOOK_EVENTS]).not.toContain(e);
      }
    });
    it('every installed event normalizes or is deliberately ignored', () => {
      // Guards against adding an event to the install list and forgetting to
      // map it: an installed-but-unmapped event is silent scope.
      const mapped = CODEX_HOOK_EVENTS.filter(
        (e) =>
          codexProvider.normalizeHookEvent({
            hook_event_name: e,
            session_id: 's1',
            tool_name: 'exec_command',
            tool_use_id: 't1',
            agent_id: 'a1',
          }) !== null,
      );
      expect(mapped.length).toBe(CODEX_HOOK_EVENTS.length);
    });
  });

  describe('normalizeHookEvent', () => {
    const ev = (raw: Record<string, unknown>) => codexProvider.normalizeHookEvent(raw);

    it('returns null when hook_event_name is missing', () => {
      expect(ev({ session_id: 'x' })).toBeNull();
    });
    it('returns null when session_id is missing', () => {
      expect(ev({ hook_event_name: 'Stop' })).toBeNull();
    });
    it('returns null for an event we deliberately do not install', () => {
      expect(ev({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hi' })).toBeNull();
      expect(ev({ hook_event_name: 'PreCompact', session_id: 's' })).toBeNull();
      expect(ev({ hook_event_name: 'Interrupt', session_id: 's' })).toBeNull();
    });

    it('maps SessionStart with source, cwd and transcript path', () => {
      const r = ev({
        hook_event_name: 'SessionStart',
        session_id: 's1',
        source: 'startup',
        cwd: '/repo',
        transcript_path: '/t.jsonl',
      });
      expect(r?.sessionId).toBe('s1');
      expect(r?.event).toEqual({
        kind: 'sessionStart',
        source: 'startup',
        transcriptPath: '/t.jsonl',
        cwd: '/repo',
      });
    });

    it('maps SessionEnd with its reason', () => {
      const r = ev({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'other' });
      expect(r?.event).toEqual({ kind: 'sessionEnd', reason: 'other' });
    });

    it('maps PreToolUse to toolStart carrying the real tool id', () => {
      const r = ev({
        hook_event_name: 'PreToolUse',
        session_id: 's1',
        tool_name: 'exec_command',
        tool_use_id: 'call_42',
        tool_input: { command: 'ls' },
      });
      expect(r?.event).toEqual({
        kind: 'toolStart',
        toolId: 'call_42',
        toolName: 'exec_command',
        input: { command: 'ls' },
      });
    });

    it('returns null for PreToolUse without a tool name', () => {
      expect(ev({ hook_event_name: 'PreToolUse', session_id: 's1' })).toBeNull();
    });

    it('maps PostToolUse to toolEnd using the real id, not a sentinel', () => {
      // This is the concrete win over the Claude provider: Codex carries the id
      // on both sides, so correlation does not depend on handler state.
      const r = ev({
        hook_event_name: 'PostToolUse',
        session_id: 's1',
        tool_use_id: 'call_42',
      });
      expect(r?.event).toEqual({ kind: 'toolEnd', toolId: 'call_42' });
    });

    it('falls back to the "current" sentinel when PostToolUse has no id', () => {
      const r = ev({ hook_event_name: 'PostToolUse', session_id: 's1' });
      expect(r?.event).toEqual({ kind: 'toolEnd', toolId: 'current' });
    });

    it('maps PermissionRequest to permissionRequest', () => {
      const r = ev({ hook_event_name: 'PermissionRequest', session_id: 's1' });
      expect(r?.event).toEqual({ kind: 'permissionRequest' });
    });

    it('maps Stop to turnEnd without claiming awaitingInput', () => {
      // Codex has no idle_prompt equivalent, so inventing awaitingInput would
      // mislabel a finished turn as "waiting for you".
      const r = ev({ hook_event_name: 'Stop', session_id: 's1', stop_hook_active: false });
      expect(r?.event).toEqual({ kind: 'turnEnd' });
      expect((r?.event as { awaitingInput?: boolean }).awaitingInput).toBeUndefined();
    });

    it('maps SubagentStart/Stop using agent_id as the character id', () => {
      const start = ev({
        hook_event_name: 'SubagentStart',
        session_id: 's1',
        agent_id: 'ag1',
        agent_type: 'reviewer',
        tool_use_id: 'call_9',
      });
      expect(start?.event).toEqual({
        kind: 'subagentStart',
        parentToolId: 'call_9',
        toolId: 'ag1',
        toolName: 'reviewer',
        input: undefined,
      });

      const stop = ev({
        hook_event_name: 'SubagentStop',
        session_id: 's1',
        agent_id: 'ag1',
        tool_use_id: 'call_9',
      });
      expect(stop?.event).toEqual({
        kind: 'subagentEnd',
        parentToolId: 'call_9',
        toolId: 'ag1',
      });
    });

    it('returns null for subagent events without an agent id', () => {
      expect(ev({ hook_event_name: 'SubagentStart', session_id: 's1' })).toBeNull();
      expect(ev({ hook_event_name: 'SubagentStop', session_id: 's1' })).toBeNull();
    });

    it('ignores a non-object tool_input rather than passing junk downstream', () => {
      const r = ev({
        hook_event_name: 'PreToolUse',
        session_id: 's1',
        tool_name: 'exec_command',
        tool_input: 'not-an-object',
      });
      expect((r?.event as { input?: unknown }).input).toBeUndefined();
    });
  });

  describe('formatToolStatus', () => {
    it('renders a string command', () => {
      expect(formatToolStatus('exec_command', { command: 'npm test' })).toBe('Running: npm test');
    });
    it('renders an argv-array command instead of [object Object]', () => {
      expect(formatToolStatus('exec_command', { command: ['git', 'status'] })).toBe(
        'Running: git status',
      );
    });
    it('clips a long command', () => {
      const s = formatToolStatus('exec_command', { command: 'x'.repeat(200) });
      expect(s.length).toBeLessThan(60);
      expect(s.endsWith('…')).toBe(true);
    });
    it('falls back when exec_command carries no command', () => {
      expect(formatToolStatus('exec_command', {})).toBe('Running a command');
    });
    it('names the file from an apply_patch body', () => {
      const patch = '*** Begin Patch\n*** Update File: src/deep/nested/app.ts\n@@\n-a\n+b\n';
      expect(formatToolStatus('apply_patch', { patch })).toBe('Editing app.ts');
    });
    it('handles an apply_patch that adds a file', () => {
      const patch = '*** Begin Patch\n*** Add File: pkg/new.ts\n+hello\n';
      expect(formatToolStatus('apply_patch', { patch })).toBe('Editing new.ts');
    });
    it('falls back for apply_patch with an unparseable body', () => {
      expect(formatToolStatus('apply_patch', { patch: 'garbage' })).toBe('Editing files');
    });
    it('renders the remaining Codex tools', () => {
      expect(formatToolStatus('update_plan', {})).toBe('Updating the plan');
      expect(formatToolStatus('grep', {})).toBe('Searching code');
      expect(formatToolStatus('list_dir', {})).toBe('Listing files');
      expect(formatToolStatus('view_image', {})).toBe('Looking at an image');
      expect(formatToolStatus('request_user_input', {})).toBe('Waiting for your answer');
      expect(formatToolStatus('write_stdin', {})).toBe('Typing into a command');
    });
    it('shows only the tool half of an MCP name', () => {
      expect(formatToolStatus('lanhu__get_designs', {})).toBe('Using get_designs');
      expect(formatToolStatus('server.fetch_page', {})).toBe('Using fetch_page');
    });
    it('handles a completely unknown tool', () => {
      expect(formatToolStatus('brand_new_tool', {})).toBe('Using brand_new_tool');
    });
    it('never throws on a missing input', () => {
      for (const t of ['exec_command', 'apply_patch', 'read_file', 'grep', 'zzz']) {
        expect(() => formatToolStatus(t)).not.toThrow();
      }
    });
  });

  describe('contextWindowForModel', () => {
    const w = (m: string | undefined) => codexProvider.contextWindowForModel?.(m);

    it('returns the default window for gpt-5 / codex families', () => {
      expect(w('gpt-5.1-codex-max')).toBe(272_000);
      expect(w('gpt-5-codex')).toBe(272_000);
    });
    it('matches the longest pattern, so gpt-4.1 is not shadowed', () => {
      expect(w('gpt-4.1-2026-01-01')).toBe(1_047_576);
      expect(w('gpt-4o-mini')).toBe(128_000);
    });
    it('handles reasoning-model ids', () => {
      expect(w('o3-pro')).toBe(200_000);
      expect(w('o4-mini')).toBe(200_000);
    });
    it('returns undefined for an unknown model so the runtime keeps its estimate', () => {
      expect(w('llama-9000')).toBeUndefined();
      expect(w(undefined)).toBeUndefined();
    });
    it('is case-insensitive', () => {
      expect(w('GPT-5-Codex')).toBe(272_000);
    });
  });

  describe('buildLaunchCommand', () => {
    it('launches the codex binary in the given cwd', () => {
      const c = codexProvider.buildLaunchCommand?.('sid', '/repo');
      expect(c?.command).toBe('codex');
      expect(c?.env?.['PWD']).toBe('/repo');
    });
    it('does not pass a session id (Codex mints its own)', () => {
      const c = codexProvider.buildLaunchCommand?.('sid', '/repo');
      expect(c?.args ?? []).not.toContain('--session-id');
      expect(c?.args ?? []).not.toContain('sid');
    });
    it('passes the bypass flag only when asked', () => {
      expect(codexProvider.buildLaunchCommand?.('s', '/r')?.args).toEqual([]);
      expect(
        codexProvider.buildLaunchCommand?.('s', '/r', { bypassPermissions: true })?.args,
      ).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
    });
  });
});
