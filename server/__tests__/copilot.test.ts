import { describe, expect, it } from 'vitest';

import { copilotProvider } from '../src/providers/hook/copilot/copilot.js';

describe('copilotProvider', () => {
  it('has copilot identity metadata', () => {
    expect(copilotProvider.kind).toBe('hook');
    expect(copilotProvider.id).toBe('copilot');
    expect(copilotProvider.displayName).toBe('GitHub Copilot');
    expect(copilotProvider.protocolVersion).toBe(1);
  });

  it('normalizes camelCase PreToolUse payloads', () => {
    const result = copilotProvider.normalizeHookEvent({
      hookEventName: 'PreToolUse',
      sessionId: 'sess-1',
      toolName: 'Read',
      toolInput: { filePath: '/tmp/a.ts' },
    });
    expect(result?.sessionId).toBe('sess-1');
    expect(result?.event.kind).toBe('toolStart');
    if (result?.event.kind === 'toolStart') {
      expect(result.event.toolName).toBe('Read');
      expect(result.event.toolId.startsWith('hook-')).toBe(true);
    }
  });

  it('normalizes SessionStart with camelCase fields', () => {
    const result = copilotProvider.normalizeHookEvent({
      hookEventName: 'SessionStart',
      sessionId: 'sess-2',
      source: 'startup',
      transcriptPath: '/tmp/sess-2.jsonl',
      cwd: '/workspace',
    });
    expect(result?.event.kind).toBe('sessionStart');
    if (result?.event.kind === 'sessionStart') {
      expect(result.event.source).toBe('startup');
      expect(result.event.transcriptPath).toBe('/tmp/sess-2.jsonl');
      expect(result.event.cwd).toBe('/workspace');
    }
  });

  it('returns null for unknown events', () => {
    const result = copilotProvider.normalizeHookEvent({
      hookEventName: 'SomethingElse',
      sessionId: 'sess-3',
    });
    expect(result).toBeNull();
  });
});
