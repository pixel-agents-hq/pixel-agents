import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readLastSessionColor, sessionColorFromRecord } from '../src/sessionColor.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-session-color-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeTranscript(lines: unknown[]): string {
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const colorLine = (c: string) => ({ type: 'agent-color', agentColor: c, sessionId: 's' });
const filler = (n: number) => ({ type: 'user', message: { content: 'x'.repeat(n) } });

describe('sessionColorFromRecord', () => {
  it('returns null for other record types', () => {
    expect(sessionColorFromRecord({ type: 'user' })).toBeNull();
  });

  it('returns the color, and undefined for default', () => {
    expect(sessionColorFromRecord(colorLine('red'))).toBe('red');
    expect(sessionColorFromRecord(colorLine('default'))).toBeUndefined();
  });
});

describe('readLastSessionColor', () => {
  it('returns undefined without a color record or file', () => {
    expect(readLastSessionColor(writeTranscript([filler(10)]))).toBeUndefined();
    expect(readLastSessionColor(path.join(dir, 'missing.jsonl'))).toBeUndefined();
  });

  it('takes the last of several color changes', () => {
    const file = writeTranscript([colorLine('cyan'), filler(10), colorLine('pink'), filler(10)]);
    expect(readLastSessionColor(file)).toBe('pink');
  });

  it('finds a color far before the end, across chunk borders', () => {
    const lines: unknown[] = [colorLine('green')];
    for (let i = 0; i < 400; i++) lines.push(filler(1500));
    expect(readLastSessionColor(writeTranscript(lines))).toBe('green');
  });

  it('treats a reset to default as no color', () => {
    const file = writeTranscript([colorLine('red'), colorLine('default')]);
    expect(readLastSessionColor(file)).toBeUndefined();
  });
});
