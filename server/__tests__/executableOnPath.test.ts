/** Whether a command resolves on PATH: the Intro's "get Claude Code" step shows only when `claude` doesn't. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { executableOnPath } from '../src/executableOnPath.js';

describe('executableOnPath', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'on-path-'));
  fs.writeFileSync(path.join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'plain'), 'not runnable', { mode: 0o644 });
  fs.mkdirSync(path.join(dir, 'folder'));
  fs.writeFileSync(path.join(dir, 'win.CMD'), '@echo off');
  const env = { PATH: ['/nowhere', dir].join(path.delimiter) };

  it('finds an executable in any PATH folder', () => {
    expect(executableOnPath('tool', env, 'linux')).toBe(true);
  });
  it('skips files that are not executable, folders, and names not there', () => {
    if (process.platform !== 'win32') expect(executableOnPath('plain', env, 'linux')).toBe(false);
    expect(executableOnPath('folder', env, 'linux')).toBe(false);
    expect(executableOnPath('missing', env, 'linux')).toBe(false);
    expect(executableOnPath('tool', { PATH: '' }, 'linux')).toBe(false);
  });
  it('tries PATHEXT on Windows', () => {
    expect(executableOnPath('win', { ...env, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(true);
  });
});
