import { describe, expect, it } from 'vitest';

import { hermesProvider } from '../src/providers/hook/hermes/hermes.js';

describe('hermesProvider.normalizeHookEvent', () => {
  const normalize = (raw: Record<string, unknown>) => hermesProvider.normalizeHookEvent(raw);

  it('returns null for unknown events', () => {
    expect(normalize({ hook_event_name: 'unknown_event', session_id: 'abc' })).toBeNull();
  });

  it('maps on_session_start to sessionStart', () => {
    const result = normalize({
      hook_event_name: 'on_session_start',
      session_id: 'sess-123',
      model: 'claude-sonnet-4-6',
    });
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('sess-123');
    expect(result!.event.kind).toBe('sessionStart');
    expect((result!.event as { source?: string }).source).toBe('claude-sonnet-4-6');
  });

  it('maps pre_tool_call to toolStart', () => {
    const result = normalize({
      hook_event_name: 'pre_tool_call',
      session_id: 'sess-123',
      tool_name: 'terminal',
      tool_call_id: 'call-abc',
      args: { command: 'echo hello' },
    });
    expect(result).not.toBeNull();
    expect(result!.event.kind).toBe('toolStart');
    const ev = result!.event as { kind: string; toolId: string; toolName: string; input?: unknown };
    expect(ev.toolId).toBe('call-abc');
    expect(ev.toolName).toBe('terminal');
    expect(ev.input).toEqual({ command: 'echo hello' });
  });

  it('returns null for pre_tool_call missing tool_call_id', () => {
    expect(
      normalize({
        hook_event_name: 'pre_tool_call',
        session_id: 'sess-123',
        tool_name: 'terminal',
      }),
    ).toBeNull();
  });

  it('maps post_tool_call to toolEnd', () => {
    const result = normalize({
      hook_event_name: 'post_tool_call',
      session_id: 'sess-123',
      tool_call_id: 'call-abc',
    });
    expect(result!.event.kind).toBe('toolEnd');
    expect((result!.event as { toolId: string }).toolId).toBe('call-abc');
  });

  it('maps post_llm_call to turnEnd', () => {
    const result = normalize({
      hook_event_name: 'post_llm_call',
      session_id: 'sess-123',
    });
    expect(result!.event.kind).toBe('turnEnd');
  });

  it('maps on_session_end to sessionEnd', () => {
    const result = normalize({
      hook_event_name: 'on_session_end',
      session_id: 'sess-123',
    });
    expect(result!.event.kind).toBe('sessionEnd');
  });

  it('ignores subagent_stop', () => {
    expect(
      normalize({
        hook_event_name: 'subagent_stop',
        session_id: 'sess-123',
      }),
    ).toBeNull();
  });
});

describe('hermesProvider.formatToolStatus', () => {
  const fmt = (tool: string, input?: unknown) => hermesProvider.formatToolStatus(tool, input);

  it('formats terminal with command', () => {
    expect(fmt('terminal', { command: 'npm test' })).toBe('Running: npm test');
  });

  it('formats read_file with filename', () => {
    expect(fmt('read_file', { path: '/some/dir/foo.ts' })).toBe('Reading foo.ts');
  });

  it('formats write_file with filename', () => {
    expect(fmt('write_file', { path: '/some/dir/bar.ts' })).toBe('Writing bar.ts');
  });

  it('formats patch with filename', () => {
    expect(fmt('patch', { path: '/some/dir/baz.ts' })).toBe('Editing baz.ts');
  });

  it('formats search_files as generic', () => {
    expect(fmt('search_files')).toBe('Searching files');
  });

  it('formats browser as web fetch', () => {
    expect(fmt('browser')).toBe('Fetching web content');
  });

  it('formats process generically', () => {
    expect(fmt('process')).toBe('Running process');
  });

  it('formats unknown tools with Using prefix', () => {
    expect(fmt('some_unknown_tool')).toBe('Using some_unknown_tool');
  });
});

describe('hermesProvider metadata', () => {
  it('has id hermes', () => {
    expect(hermesProvider.id).toBe('hermes');
  });

  it('has kind hook', () => {
    expect(hermesProvider.kind).toBe('hook');
  });

  it('readingTools includes read_file, search_files, browser', () => {
    expect(hermesProvider.readingTools.has('read_file')).toBe(true);
    expect(hermesProvider.readingTools.has('search_files')).toBe(true);
    expect(hermesProvider.readingTools.has('browser')).toBe(true);
  });

  it('permissionExemptTools includes read_file', () => {
    expect(hermesProvider.permissionExemptTools.has('read_file')).toBe(true);
  });

  it('terminalNamePrefix is hermes', () => {
    expect(hermesProvider.terminalNamePrefix).toBe('hermes');
  });
});
