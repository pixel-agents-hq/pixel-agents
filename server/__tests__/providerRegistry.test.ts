import { describe, expect, it } from 'vitest';

import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { DEFAULT_PROVIDER_ID, getAllProviders, getProvider } from '../src/providers/index.js';

describe('provider registry', () => {
  it('resolves "claude" to the claude provider instance', () => {
    expect(getProvider('claude')).toBe(claudeProvider);
  });

  it('falls back to the default provider for an unregistered id', () => {
    expect(DEFAULT_PROVIDER_ID).toBe('claude');
    expect(getProvider('some-unknown-cli')).toBe(claudeProvider);
    expect(getProvider('web')).toBe(claudeProvider); // not yet registered
  });

  it('lists every registered provider', () => {
    const all = getAllProviders();
    expect(all).toContain(claudeProvider);
    expect(all).toHaveLength(1);
  });
});
