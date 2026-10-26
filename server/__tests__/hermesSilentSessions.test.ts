/** The silent-sources opt-in: one predicate, two gates (wire platform + store
 *  source), and 'subagent' deliberately outside the switch — its children are
 *  already rendered as Subtask sub-characters by the scanner, so opening the
 *  wire for them would double-render instead of reveal. */
import { afterEach, describe, expect, it } from 'vitest';

import {
  areSilentSessionsShown,
  HERMES_TOGGLEABLE_SILENT_SOURCES,
  isSilentSource,
  setSilentSessionsShown,
} from '../src/providers/hook/hermes/constants.js';
import { hookProviders } from '../src/providers/index.js';

const hermes = hookProviders.find((provider) => provider.id === 'hermes');
if (!hermes) throw new Error('hermes provider must be registered');

/** Hermes carries platform in `extra`; tool events carry none at all. */
function envelope(platform?: string, name = 'on_session_start'): Record<string, unknown> {
  return {
    hook_event_name: name,
    session_id: '20261025_120000_abcdef',
    ...(platform === undefined ? {} : { extra: { platform } }),
  };
}

afterEach(() => {
  // Module-level ref: a leak here would silently un-pin every drop assertion.
  setSilentSessionsShown(false);
});

describe('isSilentSource', () => {
  it('drops every toggleable source while the opt-in is off', () => {
    for (const source of ['cron', 'batch', 'oneshot', 'unknown']) {
      expect(isSilentSource(source)).toBe(true);
    }
  });

  it('releases all four once the opt-in is on, and the ref is readable', () => {
    expect(areSilentSessionsShown()).toBe(false);
    setSilentSessionsShown(true);
    expect(areSilentSessionsShown()).toBe(true);
    for (const source of ['cron', 'batch', 'oneshot', 'unknown']) {
      expect(isSilentSource(source)).toBe(false);
    }
  });

  it("keeps 'subagent' structural in BOTH positions", () => {
    expect(isSilentSource('subagent')).toBe(true);
    setSilentSessionsShown(true);
    expect(isSilentSource('subagent')).toBe(true);
    expect(HERMES_TOGGLEABLE_SILENT_SOURCES.has('subagent')).toBe(false);
  });

  it('never drops interactive surfaces, nor a missing platform', () => {
    for (const source of ['cli', 'tui', 'desktop', 'gateway', 'telegram', '']) {
      expect(isSilentSource(source || undefined)).toBe(false);
    }
    expect(isSilentSource(undefined)).toBe(false);
  });
});

describe('hermes hook normalization respects the opt-in', () => {
  it('drops a cron session start while silent sources are hidden', () => {
    expect(hermes.normalizeHookEvent(envelope('cron') as never)).toBeNull();
    expect(hermes.normalizeHookEvent(envelope('batch') as never)).toBeNull();
  });

  it('emits the session start once the user opts in', () => {
    setSilentSessionsShown(true);
    const normalized = hermes.normalizeHookEvent(envelope('cron') as never);
    expect(normalized).not.toBeNull();
    expect(normalized!.sessionId).toBe('20261025_120000_abcdef');
    expect(normalized!.event.kind).toBe('sessionStart');
  });

  it('drops a cron turn end while hidden and emits it once opted in', () => {
    expect(hermes.normalizeHookEvent(envelope('cron', 'on_session_end') as never)).toBeNull();
    setSilentSessionsShown(true);
    expect(hermes.normalizeHookEvent(envelope('cron', 'on_session_end') as never)!.event.kind).toBe(
      'turnEnd',
    );
  });

  it('stays silent for a subagent child even with the opt-in on', () => {
    setSilentSessionsShown(true);
    expect(hermes.normalizeHookEvent(envelope('subagent') as never)).toBeNull();
  });

  it('never drops an event that carries no platform at all', () => {
    expect(hermes.normalizeHookEvent(envelope(undefined, 'pre_tool_call') as never)).not.toBeNull();
  });
});
