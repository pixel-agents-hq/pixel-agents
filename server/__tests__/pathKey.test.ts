import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { exists, realPath, realPathKey, sameFolder } from '../src/pathKey.js';
import { removeTempDir } from './helpers/removeTempDir.js';

/** The one comparison for Worktree folders: every spelling of a folder is the folder. */

const made: string[] = [];
function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-pathkey-')));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) removeTempDir(dir);
});

describe('sameFolder', () => {
  it('matches a folder and its spelling through a symlink', () => {
    const base = tempDir();
    const real = path.join(base, 'repo');
    fs.mkdirSync(path.join(real, '.claude', 'worktrees', 'x'), { recursive: true });
    const link = path.join(base, 'link');
    fs.symlinkSync(real, link, 'dir');

    expect(
      sameFolder(path.join(link, '.claude/worktrees/x'), path.join(real, '.claude/worktrees/x')),
    ).toBe(true);
    expect(sameFolder(link, real)).toBe(true);
    expect(sameFolder(path.join(real, 'a'), path.join(real, 'b'))).toBe(false);
  });

  it('matches a folder that is gone through its existing symlinked ancestor', () => {
    const base = tempDir();
    const real = path.join(base, 'repo');
    fs.mkdirSync(real);
    const link = path.join(base, 'link');
    fs.symlinkSync(real, link, 'dir');

    expect(sameFolder(path.join(link, 'parked', 'gone'), path.join(real, 'parked', 'gone'))).toBe(
      true,
    );
    expect(realPath(path.join(link, 'parked'))).toBe(path.join(real, 'parked'));
    expect(realPathKey(path.join(link, 'parked'))).toBe(realPathKey(path.join(real, 'parked')));
  });

  it('matches unresolved spellings (relative, trailing parts) and treats undefined as its own value', () => {
    const base = tempDir();
    expect(sameFolder(path.join(base, 'x', '..', 'y'), path.join(base, 'y'))).toBe(true);
    expect(sameFolder(undefined, undefined)).toBe(true);
    expect(sameFolder(base, undefined)).toBe(false);
  });
});

describe('exists', () => {
  it('counts files, folders and dangling links; not missing paths', () => {
    const base = tempDir();
    fs.writeFileSync(path.join(base, 'f'), '');
    fs.symlinkSync(path.join(base, 'nowhere'), path.join(base, 'dangling'));
    expect(exists(base)).toBe(true);
    expect(exists(path.join(base, 'f'))).toBe(true);
    expect(exists(path.join(base, 'dangling'))).toBe(true);
    expect(exists(path.join(base, 'nowhere'))).toBe(false);
  });
});
