/**
 * The server's ONE set of token/Host/origin predicates. Every gate (/ws in both
 * modes, /terminal/:agentId, the hook endpoint) is built from these, so their
 * edge cases are pinned here once rather than per route.
 */

import { describe, expect, it } from 'vitest';

import {
  bearerTokenValid,
  isAllowedWebSocketOrigin,
  isLoopbackHost,
  normalizeHostname,
  timingSafeStringEqual,
} from '../src/wsAuth.js';

describe('timingSafeStringEqual', () => {
  it('accepts only the exact string', () => {
    expect(timingSafeStringEqual('secret-token', 'secret-token')).toBe(true);
    expect(timingSafeStringEqual('wrong-token!', 'secret-token')).toBe(false);
  });

  it('absorbs length mismatches instead of throwing', () => {
    // crypto.timingSafeEqual throws on a length mismatch -- the pre-check must
    // turn that into a plain false rather than 500ing the upgrade.
    expect(timingSafeStringEqual('', 'secret')).toBe(false);
    expect(timingSafeStringEqual('secret-but-longer', 'secret')).toBe(false);
    expect(timingSafeStringEqual('sec', 'secret')).toBe(false);
  });
});

describe('bearerTokenValid', () => {
  it('requires the Bearer scheme with the exact token', () => {
    expect(bearerTokenValid('Bearer tok', 'tok')).toBe(true);
    expect(bearerTokenValid('tok', 'tok')).toBe(false);
    expect(bearerTokenValid('Bearer other', 'tok')).toBe(false);
    expect(bearerTokenValid(undefined, 'tok')).toBe(false);
  });
});

describe('isAllowedWebSocketOrigin', () => {
  it('allows our own origin', () => {
    expect(isAllowedWebSocketOrigin('http://127.0.0.1:3100', '127.0.0.1:3100')).toBe(true);
    expect(isAllowedWebSocketOrigin('https://localhost:8080', 'localhost:8080')).toBe(true);
  });

  it('allows a missing origin (non-browser caller)', () => {
    // Browsers omit Origin on same-origin GET and always send it cross-origin,
    // so "absent" means curl or a local script -- which can already read the
    // token from ~/.pixel-agents/server.json.
    expect(isAllowedWebSocketOrigin(undefined, '127.0.0.1:3100')).toBe(true);
    expect(isAllowedWebSocketOrigin('', '127.0.0.1:3100')).toBe(true);
  });

  it('rejects a plain cross-origin request', () => {
    expect(isAllowedWebSocketOrigin('http://evil.com', '127.0.0.1:3100')).toBe(false);
    // Same host, different port is a different origin.
    expect(isAllowedWebSocketOrigin('http://127.0.0.1:9999', '127.0.0.1:3100')).toBe(false);
  });

  it('does NOT by itself stop DNS rebinding', () => {
    // A rebound page sends BOTH Origin AND Host as the attacker domain -- the
    // Host header is the URL hostname, which the browser controls -- so this
    // check passes. Pinned so the gap stays visible.
    expect(isAllowedWebSocketOrigin('http://evil.com', 'evil.com')).toBe(true);
  });

  it('rejects unparseable origins and a missing host', () => {
    expect(isAllowedWebSocketOrigin('://nonsense', '127.0.0.1:3100')).toBe(false);
    expect(isAllowedWebSocketOrigin('http://127.0.0.1:3100', undefined)).toBe(false);
  });
});

describe('normalizeHostname', () => {
  it('strips the port and IPv6 brackets and lower-cases', () => {
    expect(normalizeHostname('127.0.0.1:3100')).toBe('127.0.0.1');
    expect(normalizeHostname('[::1]:3100')).toBe('::1');
    expect(normalizeHostname('::1')).toBe('::1');
    expect(normalizeHostname('My-Mac.Tailnet.ts.net')).toBe('my-mac.tailnet.ts.net');
  });

  it('refuses anything that is not host-shaped', () => {
    // URL parsing alone would read these as the hostname 127.0.0.1.
    expect(normalizeHostname('evil@127.0.0.1')).toBeNull();
    expect(normalizeHostname('127.0.0.1/x')).toBeNull();
    expect(normalizeHostname('')).toBeNull();
    expect(normalizeHostname(undefined)).toBeNull();
  });
});

describe('isLoopbackHost', () => {
  it('recognises loopback bind hosts and Host headers', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '127.0.0.1:3100', '[::1]:3100']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it('rejects everything else', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('evil.com:3100')).toBe(false);
    // 127.0.0.1.evil.com must not be mistaken for loopback.
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});
