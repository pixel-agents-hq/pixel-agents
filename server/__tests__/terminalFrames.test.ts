import { describe, expect, it } from 'vitest';

import {
  encodeTerminalFrame,
  parseClientFrame,
  parseServerFrame,
} from '../../core/src/terminalFrames.js';

describe('terminal frame encoding', () => {
  it('encodes output and exit frames', () => {
    expect(encodeTerminalFrame({ type: 'output', data: 'hi' })).toBe(
      '{"type":"output","data":"hi"}',
    );
    expect(encodeTerminalFrame({ type: 'exit', exitCode: 3 })).toBe('{"type":"exit","exitCode":3}');
  });

  it('round-trips control characters and multi-byte output through JSON', () => {
    // Terminal output is full of escape sequences; JSON escaping must not
    // corrupt them, since that would garble every TUI redraw.
    const data = '\x1b[31mred\x1b[0m\r\n\tünïcodé 🎉';
    const encoded = encodeTerminalFrame({ type: 'output', data });
    expect(parseServerFrame(encoded)).toEqual({ type: 'output', data });
  });
});

describe('client → server frames', () => {
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

describe('server → client frames', () => {
  it('parses replay, output and exit frames', () => {
    expect(parseServerFrame('{"type":"replay","data":"\\u001bc","cols":80,"rows":24}')).toEqual({
      type: 'replay',
      data: '\x1bc',
      cols: 80,
      rows: 24,
    });
    expect(parseServerFrame('{"type":"output","data":"x"}')).toEqual({ type: 'output', data: 'x' });
    expect(parseServerFrame('{"type":"exit","exitCode":0}')).toEqual({ type: 'exit', exitCode: 0 });
    expect(parseServerFrame('{"type":"exit","exitCode":1,"signal":9}')).toEqual({
      type: 'exit',
      exitCode: 1,
      signal: 9,
    });
  });

  it('rejects malformed and wrongly-shaped frames', () => {
    expect(parseServerFrame('nope')).toBeNull();
    expect(parseServerFrame('{"type":"output"}')).toBeNull();
    expect(parseServerFrame('{"type":"replay","data":"x","cols":0,"rows":24}')).toBeNull();
    expect(parseServerFrame('{"type":"replay","data":"x","rows":24}')).toBeNull();
    expect(parseServerFrame('{"type":"exit"}')).toBeNull();
    expect(parseServerFrame('{"type":"shell","data":"x"}')).toBeNull();
  });
});
