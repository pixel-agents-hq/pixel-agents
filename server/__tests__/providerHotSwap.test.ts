import { describe, expect, it } from 'vitest';

import { setHookProvider as setWatcherProvider } from '../src/fileWatcher.js';
import { claudeProvider, codexProvider, resolveProvider } from '../src/providers/index.js';
import { setHookProvider as setTranscriptProvider } from '../src/transcriptParser.js';

describe('provider hot-swap', () => {
  it('re-injects provider into transcript parser and file watcher', () => {
    setTranscriptProvider(claudeProvider);
    setWatcherProvider(claudeProvider);
    expect(resolveProvider('claude-code').id).toBe('claude');

    setTranscriptProvider(codexProvider);
    setWatcherProvider(codexProvider);
    expect(resolveProvider('codex').id).toBe('codex');

    setTranscriptProvider(claudeProvider);
    setWatcherProvider(claudeProvider);
    expect(resolveProvider('').id).toBe('claude');
  });

  it('falls back to Claude for unknown engine values', () => {
    expect(resolveProvider('copilot').id).toBe('claude');
    expect(resolveProvider('unknown-engine').id).toBe('claude');
  });
});
