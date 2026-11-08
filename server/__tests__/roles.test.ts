import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ROLE_FILE_MAX_BYTES, ROLE_LIST_MAX_ENTRIES } from '../src/constants.js';
import { saveUserDirectory } from '../src/directories.js';
import {
  decodeRoleContent,
  escapeInvisibleCharacters,
  isValidRoleId,
  listRoles,
  openRolesDirectory,
  pickListableRoles,
  readRoleFile,
  resolveRegisteredDirectory,
  roleNameFor,
  type ScannedRoleEntry,
} from '../src/roles.js';

/**
 * The Role domain rules on their own: id allowlist, Directory registration,
 * enumeration (lstat only, both parent levels real directories), and the
 * single checked read. $HOME is redirected so the Directory list (config.json)
 * lives in a temp dir.
 */

function fakeStats(overrides: Partial<fs.Stats> & { file?: boolean } = {}): fs.Stats {
  const isFile = overrides.file ?? true;
  return {
    dev: 1,
    ino: Math.floor(Math.random() * 1e9),
    size: 10,
    isFile: () => isFile,
    isSymbolicLink: () => false,
    ...overrides,
  } as unknown as fs.Stats;
}

describe('isValidRoleId', () => {
  it('accepts plain ASCII .md file names', () => {
    for (const id of ['frontend.md', 'a.md', 'Back_end-2.v1.md', `${'a'.repeat(64)}.md`]) {
      expect(isValidRoleId(id)).toBe(true);
    }
  });

  it('refuses paths, separators, NUL, other suffixes, overlong and reserved names', () => {
    const refused: unknown[] = [
      '../frontend.md',
      '..%2Ffrontend.md',
      'sub/frontend.md',
      'sub\\frontend.md',
      '/etc/passwd.md',
      '/abs/frontend.md',
      'C:frontend.md',
      'front\0end.md',
      'frontend.md\0',
      'frontend.txt',
      'frontend',
      'frontend.MD.txt',
      '.hidden.md',
      '-flag.md',
      `${'a'.repeat(65)}.md`,
      'CON.md',
      'con.md',
      'nul.notes.md',
      'COM1.md',
      'lpt9.md',
      'a:b.md',
      'frontend.md.',
      'frontend.md ',
      ' frontend.md',
      'fröntend.md',
      '',
      undefined,
      null,
      42,
      ['frontend.md'],
      { toString: () => 'frontend.md' },
    ];
    for (const id of refused) {
      expect(isValidRoleId(id), String(id)).toBe(false);
    }
  });

  it('derives the display name by dropping .md', () => {
    expect(roleNameFor('frontend.md')).toBe('frontend');
    expect(roleNameFor('a.b.md')).toBe('a.b');
  });
});

describe('pickListableRoles', () => {
  it('drops BOTH names of a case-insensitive duplicate, whatever their type', () => {
    const scanned: ScannedRoleEntry[] = [
      { roleId: 'Frontend.md', stats: fakeStats() },
      { roleId: 'frontend.md', stats: fakeStats() },
      { roleId: 'backend.md', stats: fakeStats() },
      { roleId: 'QA.md', stats: fakeStats({ file: false }) },
      { roleId: 'qa.md', stats: fakeStats() },
    ];
    expect(pickListableRoles(scanned).map((r) => r.roleId)).toEqual(['backend.md']);
  });

  it('lists only plain files within the size cap', () => {
    const scanned: ScannedRoleEntry[] = [
      { roleId: 'ok.md', stats: fakeStats() },
      { roleId: 'dir.md', stats: fakeStats({ file: false }) },
      { roleId: 'big.md', stats: fakeStats({ size: ROLE_FILE_MAX_BYTES + 1 }) },
      { roleId: 'edge.md', stats: fakeStats({ size: ROLE_FILE_MAX_BYTES }) },
    ];
    expect(pickListableRoles(scanned).map((r) => r.roleId)).toEqual(['edge.md', 'ok.md']);
  });

  it('caps the list', () => {
    const scanned = Array.from({ length: ROLE_LIST_MAX_ENTRIES + 20 }, (_, i) => ({
      roleId: `r${String(i).padStart(3, '0')}.md`,
      stats: fakeStats(),
    }));
    expect(pickListableRoles(scanned)).toHaveLength(ROLE_LIST_MAX_ENTRIES);
  });
});

describe('decodeRoleContent', () => {
  const ok = (s: string) => Buffer.from(s, 'utf-8');

  it('accepts text with tabs, newlines, CRLF, and zero-width / direction marks', () => {
    expect(decodeRoleContent(ok('# Role\n\tUse TS.\r\nZero​width ‎‏'))).not.toBeNull();
  });

  it('refuses invalid UTF-8', () => {
    expect(decodeRoleContent(Buffer.from([0x61, 0xc3, 0x28]))).toBeNull();
    expect(decodeRoleContent(Buffer.from([0xed, 0xa0, 0x80]))).toBeNull(); // lone surrogate
  });

  it('refuses a BOM anywhere, NUL, C0/C1 controls, tags and bidi controls', () => {
    const refused = [
      '﻿# Role',
      'mid﻿dle',
      'nul\0here',
      'bell\u0007',
      'esc\u001b[31m',
      'del\u007f',
      'c1\u0085',
      'c1\u009b',
      'tag\u{E0041}',
      'tag\u{E007F}',
      'rlo‮',
      'lre‪',
      'lri⁦',
      'pdi⁩',
    ];
    for (const text of refused) {
      expect(decodeRoleContent(ok(text)), JSON.stringify(text)).toBeNull();
    }
  });
});

describe('escapeInvisibleCharacters', () => {
  it('makes invisible characters visible and leaves ordinary text alone', () => {
    expect(escapeInvisibleCharacters('a​b‎c d⁠e­f g\th\n')).toBe(
      'a<U+200B>b<U+200E>c<U+00A0>d<U+2060>e<U+00AD>f g\th\n',
    );
    expect(escapeInvisibleCharacters('x\u{E0100}y️')).toBe('x<U+E0100>y<U+FE0F>');
  });
});

describe('Role directories on disk', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let repo: string;

  function rolesDir(base = repo): string {
    return path.join(base, '.claude', 'roles');
  }

  function writeRole(name: string, content: string | Buffer, base = repo): string {
    fs.mkdirSync(rolesDir(base), { recursive: true });
    const file = path.join(rolesDir(base), name);
    fs.writeFileSync(file, content);
    return file;
  }

  async function listed(base = repo) {
    const handle = await openRolesDirectory({ name: 'repo', path: base });
    return handle ? listRoles(handle) : [];
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-roles-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    repo = path.join(tempHome, 'repo');
    fs.mkdirSync(repo);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('lists nothing when the Directory has no .claude/roles', async () => {
    expect(await listed()).toEqual([]);
    fs.mkdirSync(path.join(repo, '.claude'));
    expect(await listed()).toEqual([]);
  });

  it('lists plain allowlisted files only, without reading them', async () => {
    writeRole('frontend.md', '# fe');
    writeRole('notes.txt', 'x');
    writeRole('.hidden.md', 'x');
    fs.mkdirSync(path.join(rolesDir(), 'sub.md'));
    fs.symlinkSync(path.join(rolesDir(), 'frontend.md'), path.join(rolesDir(), 'link.md'));
    execFileSync('mkfifo', [path.join(rolesDir(), 'pipe.md')]);
    writeRole('big.md', Buffer.alloc(ROLE_FILE_MAX_BYTES + 1, 0x61));

    expect((await listed()).map((r) => [r.roleId, r.name])).toEqual([['frontend.md', 'frontend']]);
  });

  it('lists nothing when .claude is a symlink', async () => {
    const elsewhere = path.join(tempHome, 'elsewhere');
    writeRole('frontend.md', '# fe', elsewhere);
    fs.symlinkSync(path.join(elsewhere, '.claude'), path.join(repo, '.claude'));
    expect(await listed()).toEqual([]);
  });

  it('lists nothing when .claude/roles is a symlink', async () => {
    const elsewhere = path.join(tempHome, 'elsewhere');
    writeRole('frontend.md', '# fe', elsewhere);
    fs.mkdirSync(path.join(repo, '.claude'));
    fs.symlinkSync(rolesDir(elsewhere), rolesDir());
    expect(await listed()).toEqual([]);
  });

  it('truncates a huge directory instead of scanning all of it', async () => {
    fs.mkdirSync(rolesDir(), { recursive: true });
    for (let i = 0; i < 260; i++) {
      fs.writeFileSync(path.join(rolesDir(), `r${String(i).padStart(3, '0')}.md`), 'x');
    }
    const roles = await listed();
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.length).toBeLessThanOrEqual(ROLE_LIST_MAX_ENTRIES);
  });

  it('drops case duplicates on a case-sensitive volume (skipped where the volume folds case)', async () => {
    writeRole('Frontend.md', 'a');
    writeRole('frontend.md', 'b');
    const entries = fs.readdirSync(rolesDir());
    if (entries.length < 2) return; // case-insensitive volume: covered by pickListableRoles
    expect(await listed()).toEqual([]);
  });

  it('reads the listed file once, with its sha256', async () => {
    writeRole('frontend.md', '# fe\n');
    const handle = (await openRolesDirectory({ name: 'repo', path: repo }))!;
    const [role] = await listRoles(handle);
    const read = await readRoleFile(handle, role);
    expect(typeof read).toBe('object');
    if (typeof read === 'object') {
      expect(read.text).toBe('# fe\n');
      expect(read.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('refuses a FIFO swapped in after the listing (no hang)', async () => {
    const file = writeRole('frontend.md', '# fe');
    const handle = (await openRolesDirectory({ name: 'repo', path: repo }))!;
    const [role] = await listRoles(handle);
    fs.rmSync(file);
    execFileSync('mkfifo', [file]);
    expect(await readRoleFile(handle, role)).toBe('unreadable');
  });

  it('refuses a symlink or a different file swapped in after the listing', async () => {
    const file = writeRole('frontend.md', '# fe');
    const handle = (await openRolesDirectory({ name: 'repo', path: repo }))!;
    const [role] = await listRoles(handle);
    const outside = path.join(tempHome, 'secret.md');
    fs.writeFileSync(outside, 'secret');
    fs.rmSync(file);
    fs.symlinkSync(outside, file);
    expect(await readRoleFile(handle, role)).toBe('unreadable');

    fs.rmSync(file);
    fs.writeFileSync(file, '# replaced');
    expect(await readRoleFile(handle, role)).toBe('unreadable');
  });

  it('refuses a file deleted after the listing', async () => {
    const file = writeRole('frontend.md', '# fe');
    const handle = (await openRolesDirectory({ name: 'repo', path: repo }))!;
    const [role] = await listRoles(handle);
    fs.rmSync(file);
    expect(await readRoleFile(handle, role)).toBe('unreadable');
  });

  it('refuses a file grown past the cap after the listing, reading at most cap + 1', async () => {
    const file = writeRole('frontend.md', '# fe');
    const handle = (await openRolesDirectory({ name: 'repo', path: repo }))!;
    const [role] = await listRoles(handle);
    fs.writeFileSync(file, Buffer.alloc(ROLE_FILE_MAX_BYTES + 100, 0x61));
    expect(await readRoleFile(handle, role)).toBe('tooLarge');
  });

  it('refuses content with forbidden characters', async () => {
    writeRole('frontend.md', 'x‮y');
    const handle = (await openRolesDirectory({ name: 'repo', path: repo }))!;
    const [role] = await listRoles(handle);
    expect(await readRoleFile(handle, role)).toBe('badContent');
  });

  describe('resolveRegisteredDirectory', () => {
    it('matches registered Directories only, by normalized path', () => {
      saveUserDirectory({ name: 'Repo', path: repo });
      expect(resolveRegisteredDirectory(repo, [])).toEqual({ name: 'Repo', path: repo });
      expect(resolveRegisteredDirectory(`${repo}/`, [])).toEqual({ name: 'Repo', path: repo });
      expect(resolveRegisteredDirectory(path.join(tempHome, 'other'), [])).toBeNull();
      expect(resolveRegisteredDirectory(path.join(repo, 'sub'), [])).toBeNull();
      for (const bad of [undefined, null, 42, [repo], '', `${repo}\0`]) {
        expect(resolveRegisteredDirectory(bad, [])).toBeNull();
      }
    });

    it('resolves <registered>/link/.. to the registered entry, never the link target', () => {
      saveUserDirectory({ name: 'Repo', path: repo });
      const elsewhere = path.join(tempHome, 'elsewhere', 'deep');
      fs.mkdirSync(elsewhere, { recursive: true });
      fs.symlinkSync(elsewhere, path.join(repo, 'link'));
      expect(resolveRegisteredDirectory(path.join(repo, 'link') + '/..', [])).toEqual({
        name: 'Repo',
        path: repo,
      });
    });

    it('counts host Directories as registered', () => {
      expect(resolveRegisteredDirectory(repo, [{ name: 'Host', path: repo }])).toEqual({
        name: 'Host',
        path: repo,
      });
    });
  });
});
