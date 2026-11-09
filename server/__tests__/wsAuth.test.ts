/**
 * The server's ONE set of token/Host/origin predicates. Every socket gate (/ws in
 * both modes, /terminal/:agentId, the hook endpoint) is built from these, so
 * their edge cases are pinned here once rather than per route.
 */

import { describe, expect, it } from 'vitest';

import {
  bearerTokenValid,
  isAllowedWebSocketOrigin,
  isLoopbackHost,
  normalizeHostname,
  privilegedHostnames,
  redactTokenQuery,
  standaloneHandshakeVerdict,
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

  it('does NOT by itself stop DNS rebinding (that is the Host allowlist job)', () => {
    // A rebound page sends BOTH Origin AND Host as the attacker domain -- the
    // Host header is the URL hostname, which the browser controls -- so this
    // check passes. Privilege rides standaloneHandshakeVerdict (token + Host
    // allowlist), not this check. Pinning this so nobody "fixes" it in the
    // wrong layer.
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

describe('privilegedHostnames', () => {
  it('is loopback only by default', () => {
    expect([...privilegedHostnames('127.0.0.1', [])].sort()).toEqual([
      '127.0.0.1',
      '::1',
      'localhost',
    ]);
  });

  it('adds a specific bind address and every --allowed-host, but never a wildcard', () => {
    const names = privilegedHostnames('192.168.1.5', ['My-Mac.tailnet.ts.net']);
    expect(names.has('192.168.1.5')).toBe(true);
    expect(names.has('my-mac.tailnet.ts.net')).toBe(true);
    expect(privilegedHostnames('0.0.0.0', []).has('0.0.0.0')).toBe(false);
    expect(privilegedHostnames('::', []).has('::')).toBe(false);
  });
});

describe('standaloneHandshakeVerdict', () => {
  const TOKEN = 'secret-token-1234';
  const allowed = privilegedHostnames('127.0.0.1', ['mac.tailnet.ts.net']);
  const verdict = (url: string, host: string | undefined) =>
    standaloneHandshakeVerdict(url, host, TOKEN, allowed);

  it('privileges the token under loopback or an allowed host', () => {
    expect(verdict(`/ws?token=${TOKEN}`, '127.0.0.1:3100')).toBe('privileged');
    expect(verdict(`/ws?token=${TOKEN}`, 'localhost:3100')).toBe('privileged');
    // A reverse proxy forwarding to loopback with its public name as Host.
    expect(verdict(`/terminal/1?token=${TOKEN}`, 'Mac.Tailnet.ts.net')).toBe('privileged');
  });

  it('checks the token before the Host, so a probe learns nothing', () => {
    expect(verdict('/ws', 'evil.com')).toBe('bad-token');
    expect(verdict('/ws?token=wrong', '127.0.0.1:3100')).toBe('bad-token');
  });

  it('refuses a valid token under an unlisted Host (DNS rebinding, unlisted proxy)', () => {
    expect(verdict(`/ws?token=${TOKEN}`, 'evil.com:3100')).toBe('untrusted-host');
    expect(verdict(`/ws?token=${TOKEN}`, '192.168.1.5:3100')).toBe('untrusted-host');
    expect(verdict(`/ws?token=${TOKEN}`, undefined)).toBe('untrusted-host');
  });
});
