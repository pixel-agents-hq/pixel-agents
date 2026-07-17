import { describe, expect, it } from 'vitest';

import { CONTROL_WS_PROTOCOL, TERMINAL_WS_PROTOCOL } from '../../core/src/constants.js';
import {
  encodeServerFrame,
  extractTokenFromProtocolHeader,
  isLoopbackHost,
  isLoopbackHostHeader,
  isSameOrigin,
  isTrustedTerminalRequest,
  isValidToken,
  parseClientFrame,
} from '../src/terminal/terminalProtocol.js';

describe('terminal message framing', () => {
  it('encodes output and exit frames', () => {
    expect(encodeServerFrame({ type: 'output', data: 'hi' })).toBe('{"type":"output","data":"hi"}');
    expect(encodeServerFrame({ type: 'exit', exitCode: 3 })).toBe('{"type":"exit","exitCode":3}');
  });

  it('round-trips control characters and multi-byte output through JSON', () => {
    // Terminal output is full of escape sequences; JSON escaping must not
    // corrupt them, since that would garble every TUI redraw.
    const data = '\x1b[31mred\x1b[0m\r\n\tünïcodé 🎉';
    const encoded = encodeServerFrame({ type: 'output', data });
    expect((JSON.parse(encoded) as { data: string }).data).toBe(data);
  });

  it('parses valid input and resize frames', () => {
    expect(parseClientFrame('{"type":"input","data":"ls\\r"}')).toEqual({
      type: 'input',
      data: 'ls\r',
    });
    expect(parseClientFrame('{"type":"resize","cols":120,"rows":40}')).toEqual({
      type: 'resize',
      cols: 120,
      rows: 40,
    });
  });

  it('rejects malformed, unknown, and wrongly-typed frames', () => {
    // This input arrives over an attacker-reachable socket, so anything that
    // isn't exactly right must be dropped rather than trusted.
    expect(parseClientFrame('not json')).toBeNull();
    expect(parseClientFrame('null')).toBeNull();
    expect(parseClientFrame('"a string"')).toBeNull();
    expect(parseClientFrame('{"type":"eval","data":"x"}')).toBeNull();
    expect(parseClientFrame('{"type":"input"}')).toBeNull();
    expect(parseClientFrame('{"type":"input","data":42}')).toBeNull();
    expect(parseClientFrame('{"type":"resize","cols":"80","rows":24}')).toBeNull();
    expect(parseClientFrame('{"type":"resize","cols":0,"rows":24}')).toBeNull();
    expect(parseClientFrame('{"type":"resize","cols":-1,"rows":24}')).toBeNull();
    expect(parseClientFrame('{"type":"resize","cols":80.5,"rows":24}')).toBeNull();
  });
});

describe('terminal token extraction', () => {
  it('extracts the token from a well-formed subprotocol header', () => {
    expect(extractTokenFromProtocolHeader(`${TERMINAL_WS_PROTOCOL}, abc-123`)).toBe('abc-123');
  });

  it('tolerates array headers and loose whitespace', () => {
    expect(extractTokenFromProtocolHeader([TERMINAL_WS_PROTOCOL, 'abc-123'])).toBe('abc-123');
    expect(extractTokenFromProtocolHeader(`${TERMINAL_WS_PROTOCOL},abc-123`)).toBe('abc-123');
  });

  it('returns null when the header is absent, empty, or a foreign protocol', () => {
    expect(extractTokenFromProtocolHeader(undefined)).toBeNull();
    expect(extractTokenFromProtocolHeader('')).toBeNull();
    expect(extractTokenFromProtocolHeader(TERMINAL_WS_PROTOCOL)).toBeNull();
    expect(extractTokenFromProtocolHeader('some.other.protocol, abc-123')).toBeNull();
  });

  it('extracts against a caller-supplied protocol (the /ws control socket)', () => {
    // The control socket reuses this parser with CONTROL_WS_PROTOCOL; each
    // socket only accepts its own protocol name in the first slot.
    expect(
      extractTokenFromProtocolHeader(`${CONTROL_WS_PROTOCOL}, tok-9`, CONTROL_WS_PROTOCOL),
    ).toBe('tok-9');
    expect(
      extractTokenFromProtocolHeader(`${TERMINAL_WS_PROTOCOL}, tok-9`, CONTROL_WS_PROTOCOL),
    ).toBeNull();
  });
});

describe('terminal token validation', () => {
  it('accepts only the exact token', () => {
    expect(isValidToken('secret-token', 'secret-token')).toBe(true);
    expect(isValidToken('wrong-token!', 'secret-token')).toBe(false);
  });

  it('rejects null, empty, and length-mismatched tokens without throwing', () => {
    // timingSafeEqual throws on length mismatch -- the length pre-check must
    // absorb that rather than 500ing the upgrade.
    expect(isValidToken(null, 'secret')).toBe(false);
    expect(isValidToken('', 'secret')).toBe(false);
    expect(isValidToken('secret-but-longer', 'secret')).toBe(false);
    expect(isValidToken('sec', 'secret')).toBe(false);
  });
});

describe('terminal same-origin guard', () => {
  it('allows our own origin', () => {
    expect(isSameOrigin('http://127.0.0.1:3100', '127.0.0.1:3100')).toBe(true);
    expect(isSameOrigin('https://localhost:8080', 'localhost:8080')).toBe(true);
  });

  it('allows a missing origin (non-browser caller)', () => {
    // Browsers omit Origin on same-origin GET and always send it cross-origin,
    // so "absent" means curl or a local script -- which can already read the
    // token from ~/.pixel-agents/server.json.
    expect(isSameOrigin(undefined, '127.0.0.1:3100')).toBe(true);
    expect(isSameOrigin('', '127.0.0.1:3100')).toBe(true);
  });

  it('rejects a plain cross-origin request (CORS-reflected fetch)', () => {
    // The attack this exists to stop: cors({origin:true}) reflects any Origin,
    // so without this check evil.com could fetch the terminal token. Here the
    // request still reaches us at our real Host (127.0.0.1), so origin != host.
    expect(isSameOrigin('http://evil.com', '127.0.0.1:3100')).toBe(false);
    // Same host, different port is a different origin.
    expect(isSameOrigin('http://127.0.0.1:9999', '127.0.0.1:3100')).toBe(false);
  });

  it('does NOT by itself stop DNS rebinding (that is the Host allowlist job)', () => {
    // A rebound page sends BOTH Origin AND Host as the attacker domain -- the
    // Host header is the URL hostname, which the browser controls -- so this
    // check passes. isTrustedTerminalRequest's loopback-Host clause is what
    // actually rejects it. Pinning this so nobody "fixes" it in the wrong layer.
    expect(isSameOrigin('http://evil.com', 'evil.com')).toBe(true);
  });

  it('rejects unparseable origins and a missing host', () => {
    expect(isSameOrigin('://nonsense', '127.0.0.1:3100')).toBe(false);
    expect(isSameOrigin('http://127.0.0.1:3100', undefined)).toBe(false);
  });
});

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
    // from the rebound URL). isSameOrigin passes; the loopback-Host clause is
    // what refuses it.
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
