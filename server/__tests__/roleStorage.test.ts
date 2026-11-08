import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addTrustedRole,
  checkRolesStorage,
  ensureRolesStorage,
  isRoleTrusted,
  removeRoleSnapshot,
  removeStaleRoleSnapshots,
  RoleStorageUnsafeError,
  RoleTrustUnreadableError,
  type TrustEntry,
  writeRoleSnapshot,
} from '../src/roleStorage.js';
import { writeFileSecure } from '../src/secureFileWrite.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function mode(p: string): number {
  return fs.lstatSync(p).mode & 0o777;
}

/** A pid that certainly belongs to no process: one that just exited. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '']);
  return result.pid as number;
}

describe('writeFileSecure', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-securewrite-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes 0600 atomically and leaves no tmp file', async () => {
    const target = path.join(dir, 'file.json');
    await writeFileSecure(target, 'one');
    await writeFileSecure(target, 'two');
    expect(fs.readFileSync(target, 'utf-8')).toBe('two');
    expect(mode(target)).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['file.json']);
  });

  it('throws and removes its tmp file when the rename fails', async () => {
    const target = path.join(dir, 'occupied');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep'), 'x');
    await expect(writeFileSecure(target, 'data')).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual(['occupied']);
  });

  it('throws when the directory cannot be written', async () => {
    await expect(writeFileSecure(path.join(dir, 'missing', 'f'), 'x')).rejects.toThrow();
  });

  it('replaces a symlink at the target instead of writing through it', async () => {
    const outside = path.join(dir, 'outside');
    fs.writeFileSync(outside, 'untouched');
    const target = path.join(dir, 'target');
    fs.symlinkSync(outside, target);
    await writeFileSecure(target, 'new');
    expect(fs.readFileSync(outside, 'utf-8')).toBe('untouched');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
  });
});

describe('role storage', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let rolesDir: string;
  const entry = (overrides: Partial<TrustEntry> = {}): TrustEntry => ({
    directory: '/real/repo',
    roleId: 'frontend.md',
    sha256: SHA_A,
    ...overrides,
  });

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-rolestore-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    rolesDir = path.join(tempHome, '.pixel-agents', 'roles');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('creates ~/.pixel-agents/roles 0700 and trust.json 0600, and no roles.json', async () => {
    await addTrustedRole(entry());
    expect(mode(rolesDir)).toBe(0o700);
    expect(mode(path.join(rolesDir, 'trust.json'))).toBe(0o600);
    expect(fs.existsSync(path.join(tempHome, '.pixel-agents', 'roles.json'))).toBe(false);
    expect(fs.readdirSync(rolesDir)).toEqual(['trust.json']);
    expect(await isRoleTrusted(entry())).toBe(true);
    expect(await isRoleTrusted(entry({ sha256: SHA_B }))).toBe(false);
    expect(await isRoleTrusted(entry({ directory: '/real/other' }))).toBe(false);
    expect(await isRoleTrusted(entry({ roleId: 'backend.md' }))).toBe(false);
  });

  it('reads trust without creating anything', async () => {
    expect(await isRoleTrusted(entry())).toBe(false);
    await checkRolesStorage();
    expect(fs.existsSync(rolesDir)).toBe(false);
  });

  it('refuses a roles directory that is a symlink, and writes nothing through it', async () => {
    const elsewhere = path.join(tempHome, 'elsewhere');
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    fs.mkdirSync(path.dirname(rolesDir), { recursive: true });
    fs.symlinkSync(elsewhere, rolesDir);

    await expect(addTrustedRole(entry())).rejects.toBeInstanceOf(RoleStorageUnsafeError);
    await expect(isRoleTrusted(entry())).rejects.toBeInstanceOf(RoleStorageUnsafeError);
    await expect(writeRoleSnapshot(Buffer.from('x'))).rejects.toBeInstanceOf(
      RoleStorageUnsafeError,
    );
    await expect(checkRolesStorage()).rejects.toBeInstanceOf(RoleStorageUnsafeError);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a roles directory with the wrong mode, without fixing it', async () => {
    fs.mkdirSync(rolesDir, { recursive: true });
    fs.chmodSync(rolesDir, 0o755);
    await expect(addTrustedRole(entry())).rejects.toBeInstanceOf(RoleStorageUnsafeError);
    expect(mode(rolesDir)).toBe(0o755);
    expect(fs.readdirSync(rolesDir)).toEqual([]);
  });

  it('refuses a roles directory owned by someone else', async () => {
    await ensureRolesStorage();
    const uid = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    await expect(addTrustedRole(entry())).rejects.toBeInstanceOf(RoleStorageUnsafeError);
    expect(fs.readdirSync(rolesDir)).toEqual([]);
  });

  it('treats a malformed trust.json as no trust and never rewrites it', async () => {
    await ensureRolesStorage();
    const trustFile = path.join(rolesDir, 'trust.json');
    const variants = [
      '{ not json',
      '[]',
      '{"version":1}',
      '{"version":2,"trusted":[]}',
      '{"version":1,"trusted":[],"extra":true}',
      `{"version":1,"trusted":[{"directory":"/real/repo","roleId":"frontend.md","sha256":"${SHA_A}","x":1}]}`,
      `{"version":1,"trusted":[{"directory":"/real/repo","roleId":"../x.md","sha256":"${SHA_A}"}]}`,
      `{"version":1,"trusted":[{"directory":"/real/repo","roleId":"frontend.md","sha256":"nothex"}]}`,
    ];
    for (const text of variants) {
      fs.writeFileSync(trustFile, text, { mode: 0o600 });
      expect(await isRoleTrusted(entry()), text).toBe(false);
      await expect(addTrustedRole(entry()), text).rejects.toBeInstanceOf(RoleTrustUnreadableError);
      expect(fs.readFileSync(trustFile, 'utf-8')).toBe(text);
    }
  });

  it('treats a symlinked trust.json as malformed', async () => {
    await ensureRolesStorage();
    const real = path.join(tempHome, 'forged.json');
    fs.writeFileSync(real, JSON.stringify({ version: 1, trusted: [entry()] }));
    fs.symlinkSync(real, path.join(rolesDir, 'trust.json'));
    expect(await isRoleTrusted(entry())).toBe(false);
  });

  it('loses no entry when many confirmations land at once', async () => {
    const entries = Array.from({ length: 25 }, (_, i) => entry({ roleId: `r${i}.md` }));
    await Promise.all(entries.map((e) => addTrustedRole(e)));
    for (const e of entries) {
      expect(await isRoleTrusted(e)).toBe(true);
    }
    const stored = JSON.parse(fs.readFileSync(path.join(rolesDir, 'trust.json'), 'utf-8'));
    expect(stored.trusted).toHaveLength(25);
    expect(fs.readdirSync(rolesDir)).toEqual(['trust.json']);
  });

  it('writes snapshots 0600 under snapshots/<pid>/ (0700) and removes only its own', async () => {
    const snapshot = await writeRoleSnapshot(Buffer.from('# role'));
    const own = path.join(rolesDir, 'snapshots', String(process.pid));
    expect(path.dirname(snapshot)).toBe(own);
    expect(mode(snapshot)).toBe(0o600);
    expect(mode(own)).toBe(0o700);
    expect(mode(path.dirname(own))).toBe(0o700);
    expect(fs.readFileSync(snapshot, 'utf-8')).toBe('# role');

    const foreign = path.join(tempHome, 'foreign.md');
    fs.writeFileSync(foreign, 'x');
    removeRoleSnapshot(foreign);
    removeRoleSnapshot(path.join(own, '..', '..', '..', 'trust.json'));
    expect(fs.existsSync(foreign)).toBe(true);

    removeRoleSnapshot(snapshot);
    expect(fs.existsSync(snapshot)).toBe(false);
  });

  it('removes snapshots left by a dead server (e.g. SIGKILL), keeping live ones', async () => {
    await writeRoleSnapshot(Buffer.from('mine'));
    const snapshots = path.join(rolesDir, 'snapshots');
    const dead = path.join(snapshots, String(deadPid()));
    fs.mkdirSync(dead, { mode: 0o700 });
    fs.writeFileSync(path.join(dead, 'left-behind.md'), 'x');
    const alive = path.join(snapshots, String(process.ppid));
    fs.mkdirSync(alive, { mode: 0o700 });
    const notAPid = path.join(snapshots, 'not-a-pid');
    fs.mkdirSync(notAPid);

    expect(await removeStaleRoleSnapshots()).toBe(1);
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(alive)).toBe(true);
    expect(fs.existsSync(notAPid)).toBe(true);
    expect(fs.readdirSync(path.join(snapshots, String(process.pid)))).toHaveLength(1);
  });

  it('leaves stale snapshots alone when the storage is not private', async () => {
    const snapshots = path.join(rolesDir, 'snapshots');
    const dead = path.join(snapshots, String(deadPid()));
    fs.mkdirSync(dead, { recursive: true });
    fs.chmodSync(rolesDir, 0o755);
    expect(await removeStaleRoleSnapshots()).toBe(0);
    expect(fs.existsSync(dead)).toBe(true);
  });

  it('does nothing at startup when there is no roles storage', async () => {
    expect(await removeStaleRoleSnapshots()).toBe(0);
    expect(fs.existsSync(rolesDir)).toBe(false);
  });
});
