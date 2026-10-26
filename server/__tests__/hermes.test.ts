import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { hermesProvider } from '../src/providers/hook/hermes/hermes.js';

/** The Hermes outbound envelope, exactly as agent/outbound_webhooks.py
 *  serializes it (hook_event_name/profile/tool_name/tool_input/session_id/cwd/
 *  extra/delivery_id/timestamp), with a helper so each test changes one field. */
function envelope(event: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: event,
    profile: 'default',
    tool_name: null,
    tool_input: null,
    session_id: 'sess-abc',
    cwd: '/work/project',
    extra: {},
    delivery_id: 'd1',
    timestamp: '2026-10-21T12:00:00Z',
    ...fields,
  };
}

describe('hermesProvider', () => {
  describe('identity', () => {
    it('has kind "hook" and id "hermes"', () => {
      expect(hermesProvider.kind).toBe('hook');
      expect(hermesProvider.id).toBe('hermes');
    });
    it('has the user-facing displayName', () => {
      expect(hermesProvider.displayName).toBe('Hermes Agent');
    });
    it('has protocolVersion 1', () => {
      expect(hermesProvider.protocolVersion).toBe(1);
    });
    it('declares NO team provider; delegate_task spawns the Subtask sub-characters', () => {
      expect(hermesProvider.team).toBeUndefined();
      // Tier-2 parity: children of delegate_task render as sub-characters near
      // the lead (correlated from the session store), not full characters.
      expect(hermesProvider.subagentToolNames.has('delegate_task')).toBe(true);
    });
    it('classifies Hermes reading tools and not its write tools', () => {
      expect(hermesProvider.readingTools.has('read_file')).toBe(true);
      expect(hermesProvider.readingTools.has('search_files')).toBe(true);
      expect(hermesProvider.readingTools.has('terminal')).toBe(false);
    });
    it('has no file-fallback surface, but registers the store-shaped equivalents', () => {
      expect(hermesProvider.getSessionDirs).toBeUndefined();
      expect(hermesProvider.parseTranscriptLine).toBeUndefined();
      // The JSONL-shaped members are deliberately absent (Hermes keeps SQLite,
      // not transcript files); the capabilities they encode ship as:
      expect(hermesProvider.getAllSessionRoots).toBeUndefined(); // fs walk would mis-adopt diversion JSONLs
      expect(hermesProvider.createSessionScanner).toBeTypeOf('function');
      expect(hermesProvider.directorySuggestions).toBeTypeOf('function');
      // Path-less births (desktop rows store cwd = NULL) must still stage --
      // see the scanner two-beat and hookEventHandler's transient filter.
      expect(hermesProvider.stagesPathlessSessions).toBe(true);
      // The office can spawn Hermes sessions (push-only correlation rides the
      // minted session id, not a transcript file -- see buildLaunchCommand).
      expect(hermesProvider.buildLaunchCommand).toBeTypeOf('function');
    });
  });

  describe('isAvailable', () => {
    let created: string | null = null;
    function cleanup(): void {
      if (created) fs.rmSync(created, { recursive: true, force: true });
      created = null;
      delete process.env.HERMES_HOME;
    }
    afterEach(cleanup);

    it('is false when HERMES_HOME does not exist', () => {
      created = null;
      process.env.HERMES_HOME = path.join(os.tmpdir(), 'pxl-hermes-absent-home');
      expect(hermesProvider.isAvailable!()).toBe(false);
    });
    it('is true when HERMES_HOME is a real directory', () => {
      created = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hermes-present-home'));
      process.env.HERMES_HOME = created;
      expect(hermesProvider.isAvailable!()).toBe(true);
    });
  });

  describe('normalizeHookEvent', () => {
    it('drops payloads missing hook_event_name', () => {
      expect(hermesProvider.normalizeHookEvent({ session_id: 's' })).toBeNull();
    });
    it('drops payloads with empty session_id (approval-shaped kwargs, stale subs)', () => {
      expect(
        hermesProvider.normalizeHookEvent(envelope('pre_tool_call', { session_id: '' })),
      ).toBeNull();
    });
    it('drops unknown event names', () => {
      expect(hermesProvider.normalizeHookEvent(envelope('pre_gateway_dispatch'))).toBeNull();
    });

    it('maps pre_tool_call to toolStart carrying the real tool_call_id', () => {
      const out = hermesProvider.normalizeHookEvent(
        envelope('pre_tool_call', {
          tool_name: 'terminal',
          tool_input: { command: 'ls -la', background: true },
          extra: { tool_call_id: 'tc-77', turn_id: 't1' },
        }),
      );
      expect(out).not.toBeNull();
      expect(out!.sessionId).toBe('sess-abc');
      expect(out!.event).toEqual({
        kind: 'toolStart',
        toolId: 'tc-77',
        toolName: 'terminal',
        input: { command: 'ls -la', background: true },
        runInBackground: true,
      });
    });
    it('falls back to a synthetic toolId when extra.tool_call_id is absent', () => {
      const out = hermesProvider.normalizeHookEvent(
        envelope('pre_tool_call', { tool_name: 'read_file', tool_input: { path: '/x' } }),
      );
      expect(out!.event.kind).toBe('toolStart');
      const e = out!.event as { toolId: string };
      expect(e.toolId.startsWith('hook-')).toBe(true);
    });

    it('maps post_tool_call to the current-sentinel toolEnd', () => {
      const out = hermesProvider.normalizeHookEvent(
        envelope('post_tool_call', { extra: { status: 'error', duration_ms: 12 } }),
      );
      expect(out!.event).toEqual({ kind: 'toolEnd', toolId: 'current' });
    });

    it('maps on_session_start to sessionStart with cwd, without a transcript path', () => {
      const out = hermesProvider.normalizeHookEvent(
        envelope('on_session_start', { extra: { model: 'qwen', platform: 'cli' } }),
      );
      expect(out!.event).toEqual({
        kind: 'sessionStart',
        source: 'startup',
        transcriptPath: undefined,
        cwd: '/work/project',
      });
    });
    it('drops on_session_start for unattended platforms (cron/batch)', () => {
      expect(
        hermesProvider.normalizeHookEvent(
          envelope('on_session_start', { extra: { platform: 'cron' } }),
        ),
      ).toBeNull();
      expect(
        hermesProvider.normalizeHookEvent(
          envelope('on_session_start', { extra: { platform: 'batch' } }),
        ),
      ).toBeNull();
    });

    it('maps on_session_end (per-turn) to turnEnd, cron-dropped like the start', () => {
      const out = hermesProvider.normalizeHookEvent(
        envelope('on_session_end', {
          extra: { completed: true, interrupted: false, platform: 'cli' },
        }),
      );
      expect(out!.event).toEqual({ kind: 'turnEnd' });
      expect(
        hermesProvider.normalizeHookEvent(
          envelope('on_session_end', { extra: { platform: 'cron' } }),
        ),
      ).toBeNull();
    });

    it('folds the per-turn usage snapshot into turnEnd for the context gauge', () => {
      const out = hermesProvider.normalizeHookEvent(
        envelope('on_session_end', {
          extra: {
            completed: true,
            platform: 'cli',
            usage: {
              prompt_tokens: 5000,
              completion_tokens: 200,
              total_tokens: 5200,
              input_tokens: 1000,
              output_tokens: 200,
              cache_read_tokens: 4000,
              cache_write_tokens: 0,
              reasoning_tokens: 50,
            },
            context_length: 131072,
          },
        }),
      );
      // prompt side + what the model wrote: same semantics as the Claude
      // transcript figure; context_length is the provider's own denominator.
      expect(out!.event).toEqual({
        kind: 'turnEnd',
        usage: { contextTokens: 5200, maxContextTokens: 131072 },
      });
    });

    it('says nothing about the gauge when the turn reached no API response', () => {
      // usage: null = a turn that never got a response; a Hermes older than
      // the snapshot omits the key; junk and all-zero usage must never mint
      // a gauge value -- "no news" leaves the previous reading alone.
      for (const extra of [
        { usage: null },
        {},
        { usage: { prompt_tokens: 'x', completion_tokens: -5 } },
        { usage: { prompt_tokens: 0, completion_tokens: 0 } },
        { usage: 'not an object' },
      ]) {
        expect(
          hermesProvider.normalizeHookEvent(
            envelope('on_session_end', { extra: { platform: 'cli', ...extra } }),
          )!.event,
        ).toEqual({ kind: 'turnEnd' });
      }
    });

    it('omits maxContextTokens when the window is unsaid rather than guessing', () => {
      const out = hermesProvider.normalizeHookEvent(
        envelope('on_session_end', {
          extra: { usage: { prompt_tokens: 900, completion_tokens: 100 } },
        }),
      );
      expect(out!.event).toEqual({ kind: 'turnEnd', usage: { contextTokens: 1000 } });
    });

    it('maps on_human_input_request to turnEnd awaitingInput (the idle bubble)', () => {
      const out = hermesProvider.normalizeHookEvent(
        envelope('on_human_input_request', { extra: { kind: 'elicitation', platform: 'cli' } }),
      );
      expect(out!.event).toEqual({ kind: 'turnEnd', awaitingInput: true });
    });

    it('maps pre_approval_request to permissionRequest (the approval bubble)', () => {
      const out = hermesProvider.normalizeHookEvent(
        envelope('pre_approval_request', {
          tool_name: 'terminal',
          extra: { command: 'rm -rf /var', surface: 'cli', session_key: 'cli:1' },
        }),
      );
      expect(out!.event).toEqual({ kind: 'permissionRequest' });
    });

    it('maps post_approval_response to permissionResolved (clears the bubble)', () => {
      const out = hermesProvider.normalizeHookEvent(
        envelope('post_approval_response', { extra: { choice: 'deny', surface: 'cli' } }),
      );
      expect(out!.event).toEqual({ kind: 'permissionResolved' });
    });

    it('drops an approval envelope fired without a bound session (empty session_id)', () => {
      // Approval sites outside a bound observability context post '' — the
      // empty-id guard must own the drop, not a provider-specific branch.
      expect(
        hermesProvider.normalizeHookEvent(
          envelope('pre_approval_request', { session_id: '', extra: { session_key: 'web:1' } }),
        ),
      ).toBeNull();
    });

    it('maps on_session_finalize to sessionEnd', () => {
      const out = hermesProvider.normalizeHookEvent(
        envelope('on_session_finalize', { extra: { platform: 'tui' } }),
      );
      expect(out!.event).toEqual({ kind: 'sessionEnd', reason: 'tui' });
    });

    // ── scanner-only wire names (never arrive over HTTP; see hermesSessionScanner) ──
    it('routes subagent_session_start to the PARENT with the child-keyed tool id', () => {
      const out = hermesProvider.normalizeHookEvent({
        hook_event_name: 'subagent_session_start',
        session_id: 'parent-sess',
        subagent_session_id: '20261022_120000_abcdef',
        subagent_title: 'Subagent: fix the flaky suite',
        cwd: '/work/one',
      });
      expect(out!.sessionId).toBe('parent-sess');
      expect(out!.event).toEqual({
        kind: 'subagentStart',
        parentToolId: 'current',
        toolId: 'hermes-sub-20261022_120000_abcdef',
        toolName: 'fix the flaky suite',
        input: '/work/one',
      });
    });

    it('falls the sub-agent label back to the tool name for untitled children', () => {
      const out = hermesProvider.normalizeHookEvent({
        hook_event_name: 'subagent_session_start',
        session_id: 'parent-sess',
        subagent_session_id: 'kid-1',
      });
      expect((out!.event as { toolName: string }).toolName).toBe('delegate_task');
    });

    it('drops a subagent_session_start without a child id (fail closed like junk wire)', () => {
      expect(
        hermesProvider.normalizeHookEvent({
          hook_event_name: 'subagent_session_start',
          session_id: 'parent-sess',
        }),
      ).toBeNull();
    });

    it('maps subagent_session_end to the precise per-child tool id', () => {
      const out = hermesProvider.normalizeHookEvent({
        hook_event_name: 'subagent_session_end',
        session_id: 'parent-sess',
        subagent_session_id: 'kid-1',
      });
      expect(out!.event).toEqual({
        kind: 'subagentEnd',
        parentToolId: 'current',
        toolId: 'hermes-sub-kid-1',
      });
      // A malformed end degrades to the group sentinel (Claude's shape).
      const degraded = hermesProvider.normalizeHookEvent({
        hook_event_name: 'subagent_session_end',
        session_id: 'parent-sess',
      });
      expect((degraded!.event as { toolId: string }).toolId).toBe('current');
    });

    it('rejects scanner events on an empty session id like every other event', () => {
      expect(
        hermesProvider.normalizeHookEvent({
          hook_event_name: 'subagent_session_start',
          session_id: '',
          subagent_session_id: 'kid-1',
        }),
      ).toBeNull();
    });
  });

  describe('buildLaunchCommand', () => {
    const launch = () =>
      hermesProvider.buildLaunchCommand!('candidate-uuid-ignored', 'C:\\work\\dir');

    it('mints a Hermes-format session id and returns it for registration', () => {
      const cmd = launch();
      // hermes_state_ids contract: <YYYYmmdd_HHMMSS>_<6 hex>. A uuid would be
      // rejected by the CLI's validation -- this is the whole reason the
      // provider overrides the candidate id.
      expect(cmd.sessionId).toMatch(/^\d{8}_\d{6}_[0-9a-f]{6}$/);
      expect(cmd.command).toBe('hermes');
      expect(cmd.args).toEqual(['chat', '--session-id', cmd.sessionId]);
      expect(cmd.env).toEqual({ PWD: 'C:\\work\\dir' });
    });

    it('adds --yolo when the host posture bypasses approvals', () => {
      const cmd = hermesProvider.buildLaunchCommand!('x', 'C:\\work', {
        bypassPermissions: true,
      });
      expect(cmd.args).toContain('--yolo');
    });
  });

  describe('formatToolStatus', () => {
    it('renders read_file with the basename', () => {
      expect(hermesProvider.formatToolStatus('read_file', { path: '/a/b/notes.md' })).toBe(
        'Reading notes.md',
      );
    });
    it('renders terminal with the command', () => {
      expect(hermesProvider.formatToolStatus('terminal', { command: 'pytest -q' })).toBe(
        'Running: pytest -q',
      );
    });
    it('distinguishes search_files target', () => {
      expect(hermesProvider.formatToolStatus('search_files', { target: 'files' })).toBe(
        'Searching files',
      );
      expect(hermesProvider.formatToolStatus('search_files', { target: 'content' })).toBe(
        'Searching code',
      );
    });
    it('renders delegate_task goal as Subtask, unknown tools as Using <tool>', () => {
      expect(hermesProvider.formatToolStatus('delegate_task', { goal: 'triage issues' })).toBe(
        'Subtask: triage issues',
      );
      expect(hermesProvider.formatToolStatus('vision_analyze', {})).toBe('Using vision_analyze');
    });
    it('handles Windows-style paths for basename', () => {
      expect(hermesProvider.formatToolStatus('write_file', { path: 'C:\\proj\\main.py' })).toBe(
        'Writing main.py',
      );
    });
  });
});
