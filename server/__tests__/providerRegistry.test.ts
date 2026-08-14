import { describe, expect, it } from 'vitest';

import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { webProvider } from '../src/providers/hook/web/web.js';
import { DEFAULT_PROVIDER_ID, getAllProviders, getProvider } from '../src/providers/index.js';

describe('provider registry', () => {
  it('resolves "claude" and "web" to different provider instances', () => {
    expect(getProvider('claude')).toBe(claudeProvider);
    expect(getProvider('web')).toBe(webProvider);
    expect(getProvider('claude')).not.toBe(getProvider('web'));
  });

  it('falls back to the default provider for an unregistered id', () => {
    expect(DEFAULT_PROVIDER_ID).toBe('claude');
    expect(getProvider('some-unknown-cli')).toBe(claudeProvider);
  });

  it('lists every registered provider', () => {
    const all = getAllProviders();
    expect(all).toContain(claudeProvider);
    expect(all).toContain(webProvider);
    expect(all).toHaveLength(2);
  });
});
