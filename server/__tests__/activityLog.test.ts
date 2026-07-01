import { describe, expect, it } from 'vitest';

import { buildActivityEntry } from '../src/activityLog.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';

describe('buildActivityEntry', () => {
  it('maps toolStart to a tool entry with the formatted label', () => {
    const entry = buildActivityEntry(
      { kind: 'toolStart', toolId: 't1', toolName: 'Read', input: { file_path: '/x/foo.ts' } },
      claudeProvider,
      1000,
    );
    expect(entry).toEqual({ ts: 1000, kind: 'tool', label: 'Reading foo.ts', toolName: 'Read' });
  });

  it('maps subagentStart to a subagent entry', () => {
    const entry = buildActivityEntry(
      { kind: 'subagentStart', parentToolId: 'current', toolId: 's1', toolName: 'reviewer' },
      claudeProvider,
      2000,
    );
    expect(entry).toMatchObject({
      kind: 'subagent',
      label: 'Subtask: reviewer',
      toolName: 'reviewer',
    });
  });

  it('distinguishes turnEnd waiting vs done by awaitingInput', () => {
    expect(
      buildActivityEntry({ kind: 'turnEnd', awaitingInput: true }, claudeProvider, 3000),
    ).toMatchObject({ kind: 'turnEnd', label: 'Waiting for input' });
    expect(buildActivityEntry({ kind: 'turnEnd' }, claudeProvider, 3000)).toMatchObject({
      kind: 'turnEnd',
      label: 'Turn ended',
    });
  });

  it('maps permissionRequest, sessionStart, sessionEnd', () => {
    expect(buildActivityEntry({ kind: 'permissionRequest' }, claudeProvider, 4000)).toMatchObject({
      kind: 'permission',
      label: 'Needs approval',
    });
    expect(buildActivityEntry({ kind: 'sessionStart' }, claudeProvider, 5000)).toMatchObject({
      kind: 'session',
      label: 'Session started',
    });
    expect(
      buildActivityEntry({ kind: 'sessionEnd', reason: 'clear' }, claudeProvider, 6000),
    ).toMatchObject({ kind: 'session', label: 'Session ended (clear)' });
  });

  it('returns null for non-feed kinds (toolEnd)', () => {
    expect(
      buildActivityEntry({ kind: 'toolEnd', toolId: 'current' }, claudeProvider, 7000),
    ).toBeNull();
  });
});
