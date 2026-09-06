import { describe, expect, it } from 'vitest';

import {
  isLoopbackHost,
  isLoopbackHostHeader,
  isTrustedTerminalRequest,
} from '../src/terminal/terminalGuard.js';

describe('terminal loopback host detection', () => {
  it('recognises loopback bind hosts and Host headers', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    expect(isLoopbackHostHeader('127.0.0.1:3100')).toBe(true);
    expect(isLoopbackHostHeader('localhost:3100')).toBe(true);
    // IPv6 Host headers are bracketed; URL parsing keeps the brackets, which the
    // guard must strip.
    expect(isLoopbackHostHeader('[::1]:3100')).toBe(true);
  });

  it('rejects non-loopback and malformed hosts', () => {
    expect(isLoopbackHost('evil.com')).toBe(false);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHostHeader('evil.com')).toBe(false);
    expect(isLoopbackHostHeader('evil.com:3100')).toBe(false);
    // 127.0.0.1.evil.com must not be mistaken for loopback.
    expect(isLoopbackHostHeader('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHostHeader(undefined)).toBe(false);
    expect(isLoopbackHostHeader('')).toBe(false);
  });
});

describe('terminal request guard (same-origin + anti-rebinding)', () => {
  const ENFORCE = true; // server bound to loopback
  const NO_ENFORCE = false; // operator bound off-loopback (opt-in exposure)

  it('allows a genuine same-origin loopback request', () => {
    expect(isTrustedTerminalRequest('http://127.0.0.1:3100', '127.0.0.1:3100', ENFORCE)).toBe(true);
    // Same-origin GET: browser omits Origin, Host is loopback.
    expect(isTrustedTerminalRequest(undefined, '127.0.0.1:3100', ENFORCE)).toBe(true);
  });

  it('rejects a DNS-rebound request even though origin === host', () => {
    // THE regression: Origin and Host both the attacker domain (both browser-set
    // from the rebound URL). The same-origin check passes (wsAuth.test.ts pins
    // that); the loopback-Host clause is what refuses it.
    expect(isTrustedTerminalRequest('http://evil.com', 'evil.com', ENFORCE)).toBe(false);
    expect(isTrustedTerminalRequest('http://evil.com:3100', 'evil.com:3100', ENFORCE)).toBe(false);
  });

  it('rejects a plain cross-origin fetch (origin != host)', () => {
    expect(isTrustedTerminalRequest('http://evil.com', '127.0.0.1:3100', ENFORCE)).toBe(false);
  });

  it('skips the Host allowlist when bound off-loopback (deliberate exposure)', () => {
    // The operator chose --host <lan>; we cannot enumerate valid Hosts, so the
    // token is the guard and same-origin is all we enforce here.
    expect(
      isTrustedTerminalRequest('http://192.168.1.5:3100', '192.168.1.5:3100', NO_ENFORCE),
    ).toBe(true);
    // Cross-origin is still rejected regardless of bind.
    expect(isTrustedTerminalRequest('http://evil.com', '192.168.1.5:3100', NO_ENFORCE)).toBe(false);
  });
});
