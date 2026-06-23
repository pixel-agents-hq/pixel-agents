import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionRouter } from '../src/sessionRouter.js';

describe('SessionRouter', () => {
  let router: SessionRouter;

  beforeEach(() => {
    vi.useFakeTimers();
    router = new SessionRouter();
  });

  afterEach(() => {
    router.dispose();
    vi.useRealTimers();
  });

  // ── Session → Agent mapping ────────────────────────────────────────

  describe('session mapping', () => {
    it('register + resolve returns the agentId', () => {
      router.register('sess-1', 42);
      expect(router.resolve('sess-1')).toBe(42);
    });

    it('unregister removes the mapping', () => {
      router.register('sess-1', 42);
      router.unregister('sess-1');
      expect(router.resolve('sess-1')).toBeUndefined();
    });

    it('resolve returns undefined for unknown sessions', () => {
      expect(router.resolve('unknown')).toBeUndefined();
    });

    it('hasSession checks existence', () => {
      router.register('sess-1', 1);
      expect(router.hasSession('sess-1')).toBe(true);
      expect(router.hasSession('sess-2')).toBe(false);
    });
  });

  // ── Pending external sessions ──────────────────────────────────────

  describe('pending external sessions', () => {
    const pending = { sessionId: 'sess-ext', transcriptPath: '/a/b.jsonl', cwd: '/a' };

    it('storePending + confirmPending returns the info and removes it', () => {
      router.storePending('sess-ext', pending);
      expect(router.hasPending('sess-ext')).toBe(true);

      const confirmed = router.confirmPending('sess-ext');
      expect(confirmed).toEqual(pending);
      expect(router.hasPending('sess-ext')).toBe(false);
    });

    it('confirmPending returns undefined for unknown sessions', () => {
      expect(router.confirmPending('unknown')).toBeUndefined();
    });

    it('discardPending removes without returning', () => {
      router.storePending('sess-ext', pending);
      router.discardPending('sess-ext');
      expect(router.hasPending('sess-ext')).toBe(false);
    });
  });

  // ── Event buffering ────────────────────────────────────────────────

  describe('event buffering', () => {
    it('bufferEvent stores events for later', () => {
      router.bufferEvent('claude', { session_id: 'sess-1', hook_event_name: 'Stop' });
      expect(router.hasBuffered('sess-1')).toBe(true);
      expect(router.hasBuffered('sess-2')).toBe(false);
    });

    it('register flushes buffered events for that session', () => {
      router.bufferEvent('claude', { session_id: 'sess-1', hook_event_name: 'Stop' });
      router.bufferEvent('claude', { session_id: 'sess-1', hook_event_name: 'PermissionRequest' });

      const flushed = router.register('sess-1', 1);

      expect(flushed).toHaveLength(2);
      expect(flushed[0].event.hook_event_name).toBe('Stop');
      expect(flushed[1].event.hook_event_name).toBe('PermissionRequest');
      expect(router.hasBuffered('sess-1')).toBe(false);
    });

    it('register does not flush events for other sessions', () => {
      router.bufferEvent('claude', { session_id: 'sess-1', hook_event_name: 'Stop' });
      router.bufferEvent('claude', { session_id: 'sess-2', hook_event_name: 'Stop' });

      const flushed = router.register('sess-1', 1);

      expect(flushed).toHaveLength(1);
      expect(router.hasBuffered('sess-2')).toBe(true);
    });

    it('pruneExpired removes old events', () => {
      router.bufferEvent('claude', { session_id: 'sess-old', hook_event_name: 'Stop' });
      vi.advanceTimersByTime(6_000); // > HOOK_EVENT_BUFFER_MS (5s)
      router.pruneExpired();
      expect(router.hasBuffered('sess-old')).toBe(false);
    });

    it('preserves recent events during prune', () => {
      router.bufferEvent('claude', { session_id: 'sess-new', hook_event_name: 'Stop' });
      vi.advanceTimersByTime(1_000); // < HOOK_EVENT_BUFFER_MS
      router.pruneExpired();
      expect(router.hasBuffered('sess-new')).toBe(true);
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────────────

  describe('dispose', () => {
    it('clears all state', () => {
      router.register('sess-1', 1);
      router.storePending('sess-ext', {
        sessionId: 'sess-ext',
        transcriptPath: undefined,
        cwd: '/',
      });
      router.bufferEvent('claude', { session_id: 'sess-2', hook_event_name: 'Stop' });

      router.dispose();

      expect(router.resolve('sess-1')).toBeUndefined();
      expect(router.hasPending('sess-ext')).toBe(false);
      expect(router.hasBuffered('sess-2')).toBe(false);
    });
  });
});
