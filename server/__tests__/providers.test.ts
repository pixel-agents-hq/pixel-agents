import { describe, expect, it } from 'vitest';

import { claudeProvider, copilotProvider, getHookProvider } from '../src/providers/index.js';

describe('provider registry', () => {
  it('resolves explicit providers', () => {
    expect(getHookProvider('claude')).toBe(claudeProvider);
    expect(getHookProvider('copilot')).toBe(copilotProvider);
  });

  it('falls back to claude when provider id is unknown', () => {
    expect(getHookProvider('unknown-provider')).toBe(claudeProvider);
  });
});
