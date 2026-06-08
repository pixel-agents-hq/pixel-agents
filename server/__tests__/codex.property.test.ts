import * as fc from 'fast-check';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { codexProvider } from '../src/providers/hook/codex/codex.js';
import { resolveProvider } from '../src/providers/index.js';

const EVENT_KIND_BY_NAME = {
  PreToolUse: 'toolStart',
  PostToolUse: 'toolEnd',
  PostToolUseFailure: 'toolEnd',
  Stop: 'turnEnd',
  PermissionRequest: 'permissionRequest',
  SessionStart: 'sessionStart',
  SessionEnd: 'sessionEnd',
  SubagentStart: 'subagentStart',
  SubagentStop: 'subagentEnd',
} as const;

const EVENT_NAMES = Object.keys(EVENT_KIND_BY_NAME) as Array<keyof typeof EVENT_KIND_BY_NAME>;
const RUNS = 100;

const nonEmptyString = fc.string({ minLength: 1, maxLength: 80 });
const inputValue = fc.oneof(fc.string({ maxLength: 200 }), fc.boolean(), fc.integer());
const inputObject = fc.dictionary(fc.string({ minLength: 1, maxLength: 24 }), inputValue, {
  maxKeys: 8,
});

describe('codexProvider property tests', () => {
  // Feature: codex-agent-support, Property 1: Hook event normalization
  it('normalizeHookEvent maps recognized events to the correct kind', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...EVENT_NAMES),
        nonEmptyString,
        nonEmptyString,
        nonEmptyString,
        inputObject,
        (eventName, sessionId, toolName, toolUseId, toolInput) => {
          const result = codexProvider.normalizeHookEvent({
            hook_event_name: eventName,
            session_id: sessionId,
            tool_name: toolName,
            tool_use_id: toolUseId,
            tool_input: toolInput,
            transcript_path: `/tmp/codex/sessions/2026/06/08/rollout-${toolUseId}.jsonl`,
            cwd: '/workspace',
          });

          expect(result).not.toBeNull();
          expect(result?.sessionId).toBe(sessionId);
          expect(result?.event.kind).toBe(EVENT_KIND_BY_NAME[eventName]);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('normalizeHookEvent returns null for missing or unknown event fields', () => {
    fc.assert(
      fc.property(fc.constantFrom(...EVENT_NAMES), nonEmptyString, (eventName, sessionId) => {
        expect(codexProvider.normalizeHookEvent({ session_id: sessionId })).toBeNull();
        expect(codexProvider.normalizeHookEvent({ hook_event_name: eventName })).toBeNull();
      }),
      { numRuns: RUNS },
    );

    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 80 })
          .filter((value) => !(EVENT_NAMES as readonly string[]).includes(value)),
        nonEmptyString,
        (eventName, sessionId) => {
          expect(
            codexProvider.normalizeHookEvent({
              hook_event_name: eventName,
              session_id: sessionId,
            }),
          ).toBeNull();
        },
      ),
      { numRuns: RUNS },
    );
  });

  // Feature: codex-agent-support, Property 2: formatToolStatus length
  it('formatToolStatus never exceeds 80 characters and truncates long statuses', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 240 }), inputObject, (toolName, input) => {
        const status = codexProvider.formatToolStatus(toolName, input);
        expect(status.length).toBeLessThanOrEqual(80);
      }),
      { numRuns: RUNS },
    );

    fc.assert(
      fc.property(fc.string({ minLength: 120, maxLength: 240 }), (toolName) => {
        expect(codexProvider.formatToolStatus(toolName, {}).endsWith('\u2026')).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  // Feature: codex-agent-support, Property 3: Transcript line parsing
  it('parseTranscriptLine maps Codex transcript records or returns null', () => {
    fc.assert(
      fc.property(nonEmptyString, nonEmptyString, inputObject, (callId, name, input) => {
        const event = codexProvider.parseTranscriptLine?.(
          JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'function_call',
              call_id: callId,
              name,
              arguments: JSON.stringify(input),
            },
          }),
        );

        expect(event?.kind).toBe('toolStart');
        if (event?.kind === 'toolStart') {
          expect(event.toolId).toBe(callId);
          expect(event.toolName).toBe(name);
          expect(event.input).toEqual(input);
        }
      }),
      { numRuns: RUNS },
    );

    fc.assert(
      fc.property(nonEmptyString, (callId) => {
        const event = codexProvider.parseTranscriptLine?.(
          JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call_output', call_id: callId },
          }),
        );
        expect(event).toEqual({ kind: 'toolEnd', toolId: callId });
      }),
      { numRuns: RUNS },
    );

    fc.assert(
      fc.property(nonEmptyString, (cwd) => {
        const event = codexProvider.parseTranscriptLine?.(
          JSON.stringify({ type: 'session_meta', payload: { cwd, source: 'startup' } }),
        );
        expect(event).toEqual({ kind: 'sessionStart', cwd, source: 'startup' });
      }),
      { numRuns: RUNS },
    );

    expect(
      codexProvider.parseTranscriptLine?.(
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
      ),
    ).toEqual({ kind: 'turnEnd' });

    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (value) => {
        expect(() => codexProvider.parseTranscriptLine?.(`not-json:${value}`)).not.toThrow();
        expect(codexProvider.parseTranscriptLine?.(`not-json:${value}`)).toBeNull();
        expect(
          codexProvider.parseTranscriptLine?.(
            JSON.stringify({ type: 'response_item', payload: { type: value } }),
          ),
        ).toBeNull();
      }),
      { numRuns: RUNS },
    );
  });

  // Feature: codex-agent-support, Property 4: Provider resolution
  it('resolveProvider always returns a valid HookProvider', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      fc.assert(
        fc.property(fc.string({ maxLength: 80 }), (value) => {
          const provider = resolveProvider(value);
          expect(provider).toBeTruthy();
          expect(provider.kind).toBe('hook');
          if (value === 'codex') {
            expect(provider.id).toBe('codex');
          } else {
            expect(provider.id).toBe('claude');
          }
        }),
        { numRuns: RUNS },
      );
    } finally {
      warn.mockRestore();
    }
  });

  // Feature: codex-agent-support, Property 5: buildLaunchCommand structure
  it('buildLaunchCommand includes bypass flag only when requested', () => {
    fc.assert(
      fc.property(fc.uuid(), nonEmptyString, fc.boolean(), (sessionId, cwd, bypassPermissions) => {
        const launch = codexProvider.buildLaunchCommand?.(sessionId, cwd, { bypassPermissions });
        expect(launch?.command).toBe('codex');
        expect(Array.isArray(launch?.args)).toBe(true);
        if (bypassPermissions) {
          expect(launch?.args).toContain('--dangerously-bypass-approvals-and-sandbox');
        } else {
          expect(launch?.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
        }
      }),
      { numRuns: RUNS },
    );
  });

  // Feature: codex-agent-support, Property 6: getSessionDirs
  it('getSessionDirs returns home-relative paths without throwing', () => {
    const expectedRoot = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (workspacePath) => {
        const dirs = codexProvider.getSessionDirs?.(workspacePath) ?? [];
        expect(dirs.length).toBeGreaterThan(0);
        for (const dir of dirs) {
          expect(path.isAbsolute(dir)).toBe(true);
          expect(dir.startsWith(path.join(expectedRoot, 'sessions'))).toBe(true);
        }
      }),
      { numRuns: RUNS },
    );
  });
});
