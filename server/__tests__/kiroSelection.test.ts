import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { CliArgsError, parseArgs } from '../src/cli.js';
import { kiroProvider } from '../src/providers/index.js';
import { sameStandaloneAccess } from '../src/serverConfig.js';

describe('Kiro office selection', () => {
  const runtimes: AgentRuntime[] = [];
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.dispose();
  });

  it('keeps Claude as default and explicitly selects Kiro', () => {
    expect(parseArgs([]).provider).toBe('claude');
    expect(parseArgs(['--provider', 'kiro', '--port', '3100'])).toMatchObject({
      provider: 'kiro',
      port: 3100,
    });
    expect(() => parseArgs(['--provider'])).toThrow(CliArgsError);
    expect(() => parseArgs(['--provider', 'unknown'])).toThrow(CliArgsError);
  });

  it('never reuses a Claude server for a Kiro office', () => {
    const base = { terminal: true, host: '127.0.0.1', allowedHosts: [] };
    expect(sameStandaloneAccess(base, { ...base, providerId: 'kiro' })).toBe(false);
    expect(
      sameStandaloneAccess({ ...base, providerId: 'kiro' }, { ...base, providerId: 'kiro' }),
    ).toBe(true);
    expect(sameStandaloneAccess(base, { ...base, providerId: 'claude' })).toBe(true);
  });

  it('discards hook events addressed to a different provider', () => {
    const normalize = vi.fn(() => null);
    const runtime = new AgentRuntime(new AgentStateStore(), {
      ...kiroProvider,
      normalizeHookEvent: normalize,
    });
    runtimes.push(runtime);
    const event = { hook_event_name: 'Stop', session_id: 'test-session' };
    runtime.handleHookEvent('claude', event);
    expect(normalize).not.toHaveBeenCalled();
    runtime.handleHookEvent('kiro', event);
    expect(normalize).toHaveBeenCalledWith(event);
  });
});
