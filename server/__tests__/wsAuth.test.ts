/**
 * The server's ONE set of token/origin predicates. Every socket gate (/ws in
 * both modes, /terminal/:agentId, the hook endpoint) is built from these, so
 * their edge cases are pinned here once rather than per route.
 */

import { describe, expect, it } from 'vitest';

import {
  bearerTokenValid,
  isAllowedWebSocketOrigin,
  redactTokenQuery,
  standaloneTokenValid,
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

describe('standaloneTokenValid', () => {
  it('accepts the token in the handshake query on any path', () => {
    expect(standaloneTokenValid('/ws?token=tok', 'tok')).toBe(true);
    expect(standaloneTokenValid('/terminal/1?token=tok', 'tok')).toBe(true);
    expect(standaloneTokenValid('/terminal/1?token=tok&x=1', 'tok')).toBe(true);
  });

  it('rejects a missing, wrong, or same-length token', () => {
    expect(standaloneTokenValid('/ws', 'tok')).toBe(false);
    expect(standaloneTokenValid('/ws?token=', 'tok')).toBe(false);
    expect(standaloneTokenValid('/ws?token=not', 'tok')).toBe(false);
    expect(standaloneTokenValid(undefined, 'tok')).toBe(false);
  });

  it('never privileges a handshake against an empty configured token', () => {
    // '' === '' would otherwise privilege every tokenless client.
    expect(standaloneTokenValid('/ws', '')).toBe(false);
    expect(standaloneTokenValid('/ws?token=', '')).toBe(false);
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

  it('does NOT by itself stop DNS rebinding (that is the terminal guard job)', () => {
    // A rebound page sends BOTH Origin AND Host as the attacker domain -- the
    // Host header is the URL hostname, which the browser controls -- so this
    // check passes. terminalGuard's loopback-Host clause is what rejects it on
    // the terminal socket; on /ws, privilege rides the token, not this check.
    // Pinning this so nobody "fixes" it in the wrong layer.
    expect(isAllowedWebSocketOrigin('http://evil.com', 'evil.com')).toBe(true);
  });

  it('rejects unparseable origins and a missing host', () => {
    expect(isAllowedWebSocketOrigin('://nonsense', '127.0.0.1:3100')).toBe(false);
    expect(isAllowedWebSocketOrigin('http://127.0.0.1:3100', undefined)).toBe(false);
  });
});

describe('redactTokenQuery', () => {
  it('blanks the token value wherever it sits in the query', () => {
    expect(redactTokenQuery('/ws?token=abc-123')).toBe('/ws?token=[redacted]');
    expect(redactTokenQuery('/terminal/1?token=abc-123')).toBe('/terminal/1?token=[redacted]');
    expect(redactTokenQuery('/ws?x=1&token=abc&y=2')).toBe('/ws?x=1&token=[redacted]&y=2');
    expect(redactTokenQuery('/ws?token=abc#frag')).toBe('/ws?token=[redacted]#frag');
  });

  it('leaves urls without a token untouched', () => {
    expect(redactTokenQuery('/ws')).toBe('/ws');
    expect(redactTokenQuery('/api/health?tokens=3')).toBe('/api/health?tokens=3');
  });
});
