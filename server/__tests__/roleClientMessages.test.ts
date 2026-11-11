import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { type ClientMessageContext, handleClientMessage } from '../src/clientMessageHandler.js';
import { ROLE_FILE_MAX_BYTES } from '../src/constants.js';
import { saveUserDirectory } from '../src/directories.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { IPty, PtyModule } from '../src/terminal/ptyModule.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';
import { saveWorkspace } from '../src/workspaces.js';

/**
 * The Role messages end to end through handleClientMessage: a real store,
 * runtime and Directory list under a temp $HOME, real files under a temp
 * Directory, and a fake PTY module so "launched" means "spawn was called".
 */

const FLAG = '--append-system-prompt-file';
const ROLE_REPLIES = new Set(['rolesAvailable', 'rolePreview', 'roleConfirmed', 'roleRejected']);

class FakePty implements IPty {
  readonly pid = 4242;
  private exitListener: ((e: { exitCode: number }) => void) | null = null;
  onData(): void {}
  onExit(listener: (e: { exitCode: number }) => void): void {
    this.exitListener = listener;
  }
  write(): void {}
  resize(): void {}
  kill(): void {}
  exit(): void {
    this.exitListener?.({ exitCode: 0 });
  }
}

interface Spawned {
  args: string[];
  cwd: string | undefined;
  env: Record<string, string> | undefined;
  /** The snapshot's bytes at spawn time (what claude would read). */
  snapshot: Buffer | null;
  pty: FakePty;
}

function sha256(text: string | Buffer): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

describe('Role client messages', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let repo: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let sent: Array<Record<string, unknown>>;
  let broadcasts: Array<Record<string, unknown>>;
  let created: Array<Record<string, unknown>>;
  let spawned: Spawned[];
  let spawnShouldThrow: boolean;
  let manager: PtySessionManager;
  let logs: string[];

  const snapshotsDir = () =>
    path.join(tempHome, '.pixel-agents', 'roles', 'snapshots', String(process.pid));
  const snapshotFiles = () => (fs.existsSync(snapshotsDir()) ? fs.readdirSync(snapshotsDir()) : []);

  function ctx(overrides: Partial<ClientMessageContext> = {}): ClientMessageContext {
    return { store, cache: null, runtime, ptyManager: manager, ...overrides };
  }

  function rolesDir(base = repo): string {
    return path.join(base, '.claude', 'roles');
  }

  function writeRole(name: string, content: string | Buffer, base = repo): string {
    fs.mkdirSync(rolesDir(base), { recursive: true });
    const file = path.join(rolesDir(base), name);
    fs.writeFileSync(file, content);
    return file;
  }

  function register(dir: string, name = path.basename(dir)): void {
    expect(saveUserDirectory({ name, path: dir }).ok).toBe(true);
  }

  /** Dispatch and wait for this message's own Role reply (they are async). */
  async function request(
    msg: Record<string, unknown>,
    context: ClientMessageContext = ctx(),
  ): Promise<Record<string, unknown>> {
    const before = sent.length;
    handleClientMessage(msg, (m) => sent.push(m), context);
    await vi.waitFor(() => {
      expect(sent.slice(before).some((m) => ROLE_REPLIES.has(String(m.type)))).toBe(true);
    });
    return sent.slice(before).find((m) => ROLE_REPLIES.has(String(m.type)))!;
  }

  /** Launch with a Role: resolves with the rejection, or null once a PTY spawned. */
  async function launchWithRole(
    msg: Record<string, unknown>,
    context: ClientMessageContext = ctx(),
  ): Promise<Record<string, unknown> | null> {
    const before = sent.length;
    const spawnedBefore = spawned.length;
    handleClientMessage({ type: 'launchAgent', ...msg }, (m) => sent.push(m), context);
    await vi.waitFor(() => {
      const replied = sent.slice(before).some((m) => m.type === 'roleRejected');
      expect(replied || spawned.length > spawnedBefore).toBe(true);
    });
    return sent.slice(before).find((m) => m.type === 'roleRejected') ?? null;
  }

  /** Preview + confirm, as the office does before launching. */
  async function trust(roleId: string, directoryPath = repo): Promise<string> {
    const preview = await request({ type: 'requestRolePreview', directoryPath, roleId });
    expect(preview.type).toBe('rolePreview');
    const confirmed = await request({
      type: 'confirmRole',
      directoryPath,
      roleId,
      sha256: preview.sha256,
    });
    expect(confirmed.type).toBe('roleConfirmed');
    return preview.sha256 as string;
  }

  /** Nothing launched, no id used, no snapshot left. */
  function expectNothingLaunched(): void {
    expect(spawned).toHaveLength(0);
    expect(store.size).toBe(0);
    expect(store.nextAgentId.current).toBe(1);
    expect(snapshotFiles()).toEqual([]);
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-role-msg-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    repo = path.join(tempHome, 'repo');
    fs.mkdirSync(repo);
    register(repo, 'Repo');

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    runtime = new AgentRuntime(store, claudeProvider);
    sent = [];
    broadcasts = [];
    created = [];
    spawned = [];
    spawnShouldThrow = false;
    store.on('broadcast', (m) => broadcasts.push(m));
    store.on('agentAdded', (id, agent) => created.push({ id, roleName: agent.roleName }));

    const module: PtyModule = {
      spawn: (_file, args, options) => {
        if (spawnShouldThrow) throw new Error('posix_spawnp failed');
        const index = args.indexOf(FLAG);
        const pty = new FakePty();
        spawned.push({
          args: [...args],
          cwd: options.cwd,
          env: options.env,
          snapshot: index >= 0 ? fs.readFileSync(args[index + 1]) : null,
          pty,
        });
        return pty;
      },
    };
    manager = new PtySessionManager(() => ({ module, moduleId: 'fake-pty', reason: null }));

    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    runtime.dispose();
    store.dispose();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── Listing and preview ─────────────────────────────────────

  it('lists, previews (escaped, plain text) and reports trust per exact content', async () => {
    writeRole('frontend.md', '# Frontend\nzero​width\n');
    writeRole('backend.md', '# Backend\n');

    const list = await request({ type: 'requestRoles', directoryPath: repo });
    expect(list).toEqual({
      type: 'rolesAvailable',
      directoryPath: repo,
      roles: [
        { roleId: 'backend.md', name: 'backend' },
        { roleId: 'frontend.md', name: 'frontend' },
      ],
    });

    const preview = await request({
      type: 'requestRolePreview',
      directoryPath: repo,
      roleId: 'frontend.md',
    });
    const raw = Buffer.from('# Frontend\nzero​width\n');
    expect(preview).toMatchObject({
      type: 'rolePreview',
      directoryPath: repo,
      roleId: 'frontend.md',
      content: '# Frontend\nzero<U+200B>width\n',
      sha256: sha256(raw),
      size: raw.length,
      trusted: false,
    });
    expect(new Date(preview.mtime as string).toISOString()).toBe(preview.mtime);

    await trust('frontend.md');
    const again = await request({
      type: 'requestRolePreview',
      directoryPath: repo,
      roleId: 'frontend.md',
    });
    expect(again.trusted).toBe(true);

    writeRole('frontend.md', '# Frontend v2\n');
    const changed = await request({
      type: 'requestRolePreview',
      directoryPath: repo,
      roleId: 'frontend.md',
    });
    expect(changed.trusted).toBe(false);
  });

  it('never broadcasts or logs a preview, and never names the realpath in a rejection', async () => {
    const marker = 'MARKER-7f3a-content';
    writeRole('frontend.md', `# ${marker}\n`);
    const realRepo = fs.realpathSync(repo);

    await request({ type: 'requestRolePreview', directoryPath: repo, roleId: 'frontend.md' });
    const sha = await trust('frontend.md');
    expect(await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' })).toBeNull();
    writeRole('frontend.md', 'x‮');
    const rejected = await request({
      type: 'requestRolePreview',
      directoryPath: repo,
      roleId: 'frontend.md',
    });
    expect(rejected.type).toBe('roleRejected');

    const everything = JSON.stringify(broadcasts) + JSON.stringify(created) + logs.join('\n');
    expect(everything).not.toContain(marker);
    expect(everything).not.toContain(sha);
    for (const m of sent.filter((m) => m.type === 'roleRejected')) {
      expect(JSON.stringify(m)).not.toContain(realRepo);
      expect(JSON.stringify(m)).not.toContain(tempHome);
    }
    expect(logs.join('\n')).not.toContain(realRepo);
  });

  // ── Confirmation binding ────────────────────────────────────

  it('refuses a confirmation whose hash no longer matches the file', async () => {
    writeRole('frontend.md', '# v1\n');
    const preview = await request({
      type: 'requestRolePreview',
      directoryPath: repo,
      roleId: 'frontend.md',
    });
    writeRole('frontend.md', '# v2\n');
    const reply = await request({
      type: 'confirmRole',
      directoryPath: repo,
      roleId: 'frontend.md',
      sha256: preview.sha256,
    });
    expect(reply).toMatchObject({ type: 'roleRejected', code: 'untrusted' });
    expect(fs.existsSync(path.join(tempHome, '.pixel-agents', 'roles', 'trust.json'))).toBe(false);
  });

  it('refuses a malformed confirmation hash', async () => {
    writeRole('frontend.md', '# v1\n');
    for (const sha of [undefined, 'abc', 'A'.repeat(64), ['x'], 1]) {
      const reply = await request({
        type: 'confirmRole',
        directoryPath: repo,
        roleId: 'frontend.md',
        sha256: sha,
      });
      expect(reply).toMatchObject({ type: 'roleRejected', code: 'invalid' });
    }
  });

  it('keeps both entries when two clients confirm at once', async () => {
    writeRole('frontend.md', '# fe\n');
    writeRole('backend.md', '# be\n');
    const shaFe = sha256('# fe\n');
    const shaBe = sha256('# be\n');
    const a: Array<Record<string, unknown>> = [];
    const b: Array<Record<string, unknown>> = [];
    handleClientMessage(
      { type: 'confirmRole', directoryPath: repo, roleId: 'frontend.md', sha256: shaFe },
      (m) => a.push(m),
      ctx(),
    );
    handleClientMessage(
      { type: 'confirmRole', directoryPath: repo, roleId: 'backend.md', sha256: shaBe },
      (m) => b.push(m),
      ctx(),
    );
    await vi.waitFor(() => expect(a.length + b.length).toBe(2));
    expect(a[0].type).toBe('roleConfirmed');
    expect(b[0].type).toBe('roleConfirmed');
    const stored = JSON.parse(
      fs.readFileSync(path.join(tempHome, '.pixel-agents', 'roles', 'trust.json'), 'utf-8'),
    );
    expect(stored.trusted.map((e: { roleId: string }) => e.roleId).sort()).toEqual([
      'backend.md',
      'frontend.md',
    ]);
  });

  // ── Launch ──────────────────────────────────────────────────

  it('launches with a snapshot of exactly the trusted bytes, and removes it on exit', async () => {
    const content = '# Frontend rules\n';
    writeRole('frontend.md', content);
    const sha = await trust('frontend.md');

    expect(await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' })).toBeNull();

    expect(spawned).toHaveLength(1);
    const [launch] = spawned;
    const agentId = [...store][0][0];
    const agent = store.get(agentId)!;
    expect(launch.args.slice(0, 2)).toEqual(['--session-id', agent.sessionId]);
    expect(launch.args[2]).toBe(FLAG);
    const snapshotPath = launch.args[3];
    expect(path.dirname(snapshotPath)).toBe(snapshotsDir());
    expect(launch.args).toHaveLength(4);
    // Never the repo's own file.
    expect(launch.args.join(' ')).not.toContain(rolesDir());
    expect(sha256(launch.snapshot!)).toBe(sha);
    expect(fs.statSync(snapshotPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(path.dirname(snapshotPath))).mode & 0o777).toBe(0o700);
    expect(launch.cwd).toBe(repo);

    // Display name only, runtime only.
    expect(agent.roleName).toBe('frontend');
    expect(created).toEqual([{ id: agentId, roleName: 'frontend' }]);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(tempHome, '.pixel-agents', 'standalone-state.json'), 'utf-8'),
    );
    expect(JSON.stringify(persisted)).not.toContain('frontend');
    expect(JSON.stringify(persisted)).not.toContain(snapshotPath);

    // A fresh office sees the name, never the content or hash.
    const fresh: Array<Record<string, unknown>> = [];
    handleClientMessage({ type: 'webviewReady' }, (m) => fresh.push(m), ctx());
    const existing = fresh.find((m) => m.type === 'existingAgents')!;
    expect(existing.roleNames).toEqual({ [agentId]: 'frontend' });
    expect(JSON.stringify(fresh)).not.toContain(sha);
    expect(JSON.stringify(fresh)).not.toContain('Frontend rules');

    launch.pty.exit();
    expect(fs.existsSync(snapshotPath)).toBe(false);
    expect(store.size).toBe(0);
  });

  it('launches reliably right after roleConfirmed, repeatedly', async () => {
    writeRole('frontend.md', '# fe\n');
    for (let i = 0; i < 5; i++) {
      const preview = await request({
        type: 'requestRolePreview',
        directoryPath: repo,
        roleId: 'frontend.md',
      });
      const confirmed = await request({
        type: 'confirmRole',
        directoryPath: repo,
        roleId: 'frontend.md',
        sha256: preview.sha256,
      });
      expect(confirmed.type).toBe('roleConfirmed');
      expect(await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' })).toBeNull();
    }
    expect(spawned).toHaveLength(5);
    expect(snapshotFiles()).toHaveLength(5);
    for (const s of spawned) s.pty.exit();
    expect(snapshotFiles()).toEqual([]);
  });

  it('bypassPermissions on still requires the confirmation', async () => {
    writeRole('frontend.md', '# fe\n');
    handleClientMessage({ type: 'setBypassPermissions', enabled: true }, () => undefined, ctx());
    const reply = await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' });
    expect(reply).toMatchObject({ type: 'roleRejected', code: 'untrusted' });
    expectNothingLaunched();

    await trust('frontend.md');
    expect(await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' })).toBeNull();
    expect(spawned[0].args).toContain('--dangerously-skip-permissions');
    expect(spawned[0].args).toContain(FLAG);
  });

  it('refuses a file changed after confirmation, without launching', async () => {
    writeRole('frontend.md', '# v1\n');
    await trust('frontend.md');
    writeRole('frontend.md', '# v2\n');
    const reply = await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' });
    expect(reply).toMatchObject({ type: 'roleRejected', code: 'untrusted' });
    expectNothingLaunched();
  });

  it('refuses a Role deleted after it was listed: never falls back to no Role', async () => {
    const file = writeRole('frontend.md', '# fe\n');
    await trust('frontend.md');
    fs.rmSync(file);
    const reply = await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' });
    expect(reply).toMatchObject({ type: 'roleRejected', code: 'invalid' });
    expectNothingLaunched();
  });

  it('requires a new confirmation when the Directory realpath changes', async () => {
    const targetA = path.join(tempHome, 'a');
    const targetB = path.join(tempHome, 'b');
    fs.mkdirSync(targetA);
    fs.mkdirSync(targetB);
    writeRole('frontend.md', '# same\n', targetA);
    writeRole('frontend.md', '# same\n', targetB);
    const link = path.join(tempHome, 'link');
    fs.symlinkSync(targetA, link);
    register(link, 'Link');

    await trust('frontend.md', link);
    fs.rmSync(link);
    fs.symlinkSync(targetB, link);

    const reply = await launchWithRole({ directoryPath: link, roleId: 'frontend.md' });
    expect(reply).toMatchObject({ type: 'roleRejected', code: 'untrusted' });
    expectNothingLaunched();
  });

  it('uses the registered entry everywhere for <registered>/link/..', async () => {
    writeRole('frontend.md', '# registered\n');
    const elsewhere = path.join(tempHome, 'elsewhere', 'deep');
    fs.mkdirSync(elsewhere, { recursive: true });
    writeRole('frontend.md', '# elsewhere\n', path.dirname(elsewhere));
    fs.symlinkSync(elsewhere, path.join(repo, 'link'));
    const workspace = saveWorkspace({ name: 'B', directoryPaths: [repo] });
    expect(workspace.ok).toBe(true);

    const sneaky = `${path.join(repo, 'link')}/..`;
    const sha = await trust('frontend.md', sneaky);
    expect(await launchWithRole({ directoryPath: sneaky, roleId: 'frontend.md' })).toBeNull();

    const [launch] = spawned;
    const agent = [...store][0][1];
    expect(launch.cwd).toBe(repo);
    expect(launch.env?.PWD).toBe(repo);
    expect(sha256(launch.snapshot!)).toBe(sha);
    expect(launch.snapshot!.toString()).toBe('# registered\n');
    expect(agent.directoryName).toBe('Repo');
    expect(agent.workspaceId).toBe(workspace.id);
    expect(agent.projectDir).toBe(claudeProvider.getSessionDirs!(repo)[0]);
  });

  it('gives two Roles in one Directory each its own rules, over the same cwd', async () => {
    writeRole('frontend.md', '# Frontend rules\n');
    writeRole('backend.md', '# Backend rules\n');
    const frontendSha = await trust('frontend.md');
    const backendSha = await trust('backend.md');

    expect(await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' })).toBeNull();
    expect(await launchWithRole({ directoryPath: repo, roleId: 'backend.md' })).toBeNull();

    const [frontend, backend] = spawned;
    // Same working directory: the folder's CLAUDE.md (the shared layer) reaches both.
    expect(frontend.cwd).toBe(repo);
    expect(backend.cwd).toBe(repo);
    // Different snapshots: the Role layer reaches only its own agent.
    expect(frontend.args[3]).not.toBe(backend.args[3]);
    expect(frontend.snapshot!.toString()).toBe('# Frontend rules\n');
    expect(backend.snapshot!.toString()).toBe('# Backend rules\n');
    expect(sha256(frontend.snapshot!)).toBe(frontendSha);
    expect(sha256(backend.snapshot!)).toBe(backendSha);
    expect(created.map((c) => c.roleName)).toEqual(['frontend', 'backend']);

    // One agent's exit takes only its own snapshot.
    frontend.pty.exit();
    expect(fs.existsSync(frontend.args[3])).toBe(false);
    expect(fs.existsSync(backend.args[3])).toBe(true);
  });

  it('applies a same-named Role per Directory: each agent gets that Directory content', async () => {
    const other = path.join(tempHome, 'other');
    fs.mkdirSync(other);
    register(other, 'Other');
    writeRole('frontend.md', '# Repo frontend\n');
    writeRole('frontend.md', '# Other frontend\n', other);
    await trust('frontend.md', repo);
    await trust('frontend.md', other);

    expect(await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' })).toBeNull();
    expect(await launchWithRole({ directoryPath: other, roleId: 'frontend.md' })).toBeNull();

    const [inRepo, inOther] = spawned;
    expect(inRepo.cwd).toBe(repo);
    expect(inOther.cwd).toBe(other);
    expect(inRepo.snapshot!.toString()).toBe('# Repo frontend\n');
    expect(inOther.snapshot!.toString()).toBe('# Other frontend\n');
    // Same name, two different Roles: trust in one Directory does not carry over.
    const third = path.join(tempHome, 'third');
    fs.mkdirSync(third);
    register(third, 'Third');
    writeRole('frontend.md', '# Repo frontend\n', third);
    const reply = await launchWithRole({ directoryPath: third, roleId: 'frontend.md' });
    expect(reply).toMatchObject({ type: 'roleRejected', code: 'untrusted' });
  });

  it('removes the snapshot when the PTY spawn fails', async () => {
    writeRole('frontend.md', '# fe\n');
    await trust('frontend.md');
    spawnShouldThrow = true;
    const before = sent.length;
    handleClientMessage(
      { type: 'launchAgent', directoryPath: repo, roleId: 'frontend.md' },
      (m) => sent.push(m),
      ctx(),
    );
    await vi.waitFor(() =>
      expect(sent.slice(before).some((m) => m.type === 'roleRejected')).toBe(true),
    );
    expect(sent.slice(before).find((m) => m.type === 'roleRejected')).toMatchObject({ code: 'io' });
    expect(store.size).toBe(0);
    expect(store.nextAgentId.current).toBe(1);
    expect(snapshotFiles()).toEqual([]);
  });

  // ── Refusals (none launches, uses an id, or leaves a snapshot) ──

  it.each([
    ['../frontend.md'],
    ['roles/frontend.md'],
    ['..\\frontend.md'],
    ['/etc/frontend.md'],
    ['front\0end.md'],
    ['frontend.txt'],
    [`${'a'.repeat(70)}.md`],
    ['CON.md'],
    ['a:b.md'],
    ['frontend.md.'],
    ['frontend.md '],
    [['frontend.md']],
    [42],
    [null],
    [{}],
  ])('refuses roleId %j as invalid', async (roleId) => {
    writeRole('frontend.md', '# fe\n');
    await trust('frontend.md');
    for (const type of ['requestRolePreview', 'confirmRole']) {
      const reply = await request({ type, directoryPath: repo, roleId, sha256: 'a'.repeat(64) });
      expect(reply).toMatchObject({ type: 'roleRejected', code: 'invalid' });
    }
    const reply = await launchWithRole({ directoryPath: repo, roleId });
    expect(reply).toMatchObject({ type: 'roleRejected', code: 'invalid' });
    expectNothingLaunched();
  });

  it('refuses a roleId that is valid but not listed', async () => {
    writeRole('frontend.md', '# fe\n');
    fs.writeFileSync(path.join(repo, 'outside.md'), '# not a role');
    for (const roleId of ['backend.md', 'FRONTEND.md']) {
      const preview = await request({ type: 'requestRolePreview', directoryPath: repo, roleId });
      expect(preview).toMatchObject({ type: 'roleRejected', code: 'invalid' });
      const reply = await launchWithRole({ directoryPath: repo, roleId });
      expect(reply).toMatchObject({ type: 'roleRejected', code: 'invalid' });
    }
    expectNothingLaunched();
  });

  it('refuses an unregistered or missing directoryPath', async () => {
    const other = path.join(tempHome, 'other');
    writeRole('frontend.md', '# fe\n', other);
    for (const directoryPath of [other, path.join(repo, 'sub'), 42, ['x'], '']) {
      for (const type of ['requestRoles', 'requestRolePreview']) {
        const reply = await request({ type, directoryPath, roleId: 'frontend.md' });
        expect(reply).toMatchObject({ type: 'roleRejected', code: 'invalid' });
      }
      const reply = await launchWithRole({ directoryPath, roleId: 'frontend.md' });
      expect(reply).toMatchObject({ type: 'roleRejected', code: 'invalid' });
    }
    const noDir = await launchWithRole({ roleId: 'frontend.md' });
    expect(noDir).toMatchObject({ type: 'roleRejected', code: 'invalid' });
    expectNothingLaunched();
  });

  it('lists nothing and refuses launches when .claude or .claude/roles is a symlink', async () => {
    const elsewhere = path.join(tempHome, 'elsewhere');
    writeRole('frontend.md', '# fe\n', elsewhere);
    fs.symlinkSync(path.join(elsewhere, '.claude'), path.join(repo, '.claude'));
    expect(await request({ type: 'requestRoles', directoryPath: repo })).toMatchObject({
      roles: [],
    });
    expect(await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' })).toMatchObject({
      code: 'invalid',
    });

    fs.rmSync(path.join(repo, '.claude'));
    fs.mkdirSync(path.join(repo, '.claude'));
    fs.symlinkSync(rolesDir(elsewhere), rolesDir());
    expect(await request({ type: 'requestRoles', directoryPath: repo })).toMatchObject({
      roles: [],
    });
    expect(await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' })).toMatchObject({
      code: 'invalid',
    });
    expectNothingLaunched();
  });

  it.each([
    [
      'a symlink',
      (file: string) => fs.symlinkSync(path.join(path.dirname(file), 'real.txt'), file),
    ],
    ['a FIFO', (file: string) => execFileSync('mkfifo', [file])],
    [
      'oversized',
      (file: string) => fs.writeFileSync(file, Buffer.alloc(ROLE_FILE_MAX_BYTES + 1, 0x61)),
    ],
  ])('refuses a Role file that is %s', async (_label, plant) => {
    fs.mkdirSync(rolesDir(), { recursive: true });
    fs.writeFileSync(path.join(rolesDir(), 'real.txt'), '# target');
    plant(path.join(rolesDir(), 'frontend.md'));
    expect(await request({ type: 'requestRoles', directoryPath: repo })).toMatchObject({
      roles: [],
    });
    expect(
      await request({ type: 'requestRolePreview', directoryPath: repo, roleId: 'frontend.md' }),
    ).toMatchObject({ code: 'invalid' });
    expect(await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' })).toMatchObject({
      code: 'invalid',
    });
    expectNothingLaunched();
  });

  it.each([
    ['a tag character', 'x\u{E0041}'],
    ['a bidi override', 'x‮y'],
    ['a bidi isolate', 'x⁧y'],
    ['a control character', 'x\u001by'],
    ['NUL', 'x\u0000y'],
    ['a BOM', '﻿# role'],
    ['invalid UTF-8', Buffer.from([0x23, 0x20, 0xff, 0xfe])],
  ])('refuses content with %s at preview, confirm and launch', async (_label, content) => {
    writeRole('frontend.md', '# clean\n');
    await trust('frontend.md');
    writeRole('frontend.md', content);
    const sha = sha256(typeof content === 'string' ? Buffer.from(content) : content);
    expect(
      await request({ type: 'requestRolePreview', directoryPath: repo, roleId: 'frontend.md' }),
    ).toMatchObject({ type: 'roleRejected', code: 'invalid' });
    expect(
      await request({
        type: 'confirmRole',
        directoryPath: repo,
        roleId: 'frontend.md',
        sha256: sha,
      }),
    ).toMatchObject({ type: 'roleRejected', code: 'invalid' });
    expect(await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' })).toMatchObject({
      code: 'invalid',
    });
    expectNothingLaunched();
  });

  // ── Access, platform and storage ────────────────────────────

  it('answers unavailable in embedded mode (no ptyManager), with the terminal off, and on win32', async () => {
    writeRole('frontend.md', '# fe\n');
    const messages = [
      { type: 'requestRoles', directoryPath: repo },
      { type: 'requestRolePreview', directoryPath: repo, roleId: 'frontend.md' },
      { type: 'confirmRole', directoryPath: repo, roleId: 'frontend.md', sha256: sha256('# fe\n') },
    ];
    const contexts = [
      ctx({ ptyManager: undefined }),
      ctx({ ptyManager: PtySessionManager.disabled('off') }),
    ];
    for (const context of contexts) {
      for (const msg of messages) {
        expect(await request(msg, context)).toMatchObject({ code: 'unavailable' });
      }
      expect(
        await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' }, context),
      ).toMatchObject({ code: 'unavailable' });
    }

    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      for (const msg of messages) {
        expect(await request(msg)).toMatchObject({ code: 'unavailable' });
      }
      expect(await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' })).toMatchObject({
        code: 'unavailable',
      });
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    expectNothingLaunched();
  });

  it('refuses every Role operation, writing nothing, when ~/.pixel-agents/roles is not private', async () => {
    writeRole('frontend.md', '# fe\n');
    const roles = path.join(tempHome, '.pixel-agents', 'roles');
    const elsewhere = path.join(tempHome, 'elsewhere');
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    fs.symlinkSync(elsewhere, roles);
    const msgs = [
      { type: 'requestRoles', directoryPath: repo },
      { type: 'requestRolePreview', directoryPath: repo, roleId: 'frontend.md' },
      { type: 'confirmRole', directoryPath: repo, roleId: 'frontend.md', sha256: sha256('# fe\n') },
    ];
    for (const msg of msgs) {
      expect(await request(msg)).toMatchObject({ type: 'roleRejected', code: 'io' });
    }
    expect(await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' })).toMatchObject({
      code: 'io',
    });
    expect(fs.readdirSync(elsewhere)).toEqual([]);

    fs.rmSync(roles);
    fs.mkdirSync(roles, { mode: 0o755 });
    fs.chmodSync(roles, 0o755);
    for (const msg of msgs) {
      expect(await request(msg)).toMatchObject({ type: 'roleRejected', code: 'io' });
    }
    expect(fs.readdirSync(roles)).toEqual([]);
    expectNothingLaunched();
  });

  it('treats a corrupt trust.json as no trust and leaves it untouched', async () => {
    writeRole('frontend.md', '# fe\n');
    await trust('frontend.md');
    const trustFile = path.join(tempHome, '.pixel-agents', 'roles', 'trust.json');
    fs.writeFileSync(trustFile, '{ corrupt');
    const preview = await request({
      type: 'requestRolePreview',
      directoryPath: repo,
      roleId: 'frontend.md',
    });
    expect(preview.trusted).toBe(false);
    expect(
      await request({
        type: 'confirmRole',
        directoryPath: repo,
        roleId: 'frontend.md',
        sha256: preview.sha256,
      }),
    ).toMatchObject({ type: 'roleRejected', code: 'io' });
    expect(await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' })).toMatchObject({
      code: 'untrusted',
    });
    expect(fs.readFileSync(trustFile, 'utf-8')).toBe('{ corrupt');
    expectNothingLaunched();
  });

  it('leaves config.json and layout.json untouched and creates no roles.json', async () => {
    const pixelDir = path.join(tempHome, '.pixel-agents');
    const layout = path.join(pixelDir, 'layout.json');
    fs.writeFileSync(layout, '{"version":1}');
    const configBefore = fs.readFileSync(path.join(pixelDir, 'config.json'));
    const configMode = fs.statSync(path.join(pixelDir, 'config.json')).mode;
    writeRole('frontend.md', '# fe\n');

    await request({ type: 'requestRoles', directoryPath: repo });
    await trust('frontend.md');
    await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' });

    expect(fs.readFileSync(path.join(pixelDir, 'config.json'))).toEqual(configBefore);
    expect(fs.statSync(path.join(pixelDir, 'config.json')).mode).toBe(configMode);
    expect(fs.readFileSync(layout, 'utf-8')).toBe('{"version":1}');
    expect(fs.existsSync(path.join(pixelDir, 'roles.json'))).toBe(false);
    expect(fs.readdirSync(path.join(pixelDir, 'roles')).sort()).toEqual([
      'snapshots',
      'trust.json',
    ]);
  });

  // ── Launches without a Role are unchanged ───────────────────

  it('a launch without roleId spawns exactly the pre-Role command and writes no Role storage', async () => {
    handleClientMessage({ type: 'launchAgent', directoryPath: repo }, (m) => sent.push(m), ctx());
    expect(spawned).toHaveLength(1);
    const agent = [...store][0][1];
    expect(spawned[0].args).toEqual(['--session-id', agent.sessionId]);
    expect(agent.roleName).toBeUndefined();
    expect(sent.filter((m) => ROLE_REPLIES.has(String(m.type)))).toEqual([]);
    expect(fs.existsSync(path.join(tempHome, '.pixel-agents', 'roles'))).toBe(false);
  });

  it('restoring persisted agents never relaunches anything with a Role flag', async () => {
    writeRole('frontend.md', '# fe\n');
    await trust('frontend.md');
    await launchWithRole({ directoryPath: repo, roleId: 'frontend.md' });
    store.persist();
    const buildSpy = vi.spyOn(claudeProvider, 'buildLaunchCommand');

    // A "restarted" server: fresh store and runtime over the same state files.
    const store2 = new AgentStateStore();
    store2.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    const runtime2 = new AgentRuntime(store2, claudeProvider);
    const spawnedBefore = spawned.length;
    try {
      runtime2.restoreExternalAgents();
      const replies: Array<Record<string, unknown>> = [];
      handleClientMessage({ type: 'webviewReady' }, (m) => replies.push(m), {
        store: store2,
        runtime: runtime2,
        cache: null,
        ptyManager: manager,
      });
      expect(buildSpy).not.toHaveBeenCalled();
      expect(spawned.length).toBe(spawnedBefore);
      for (const [, agent] of store2) {
        expect(agent.roleName).toBeUndefined();
      }
      const existing = replies.find((m) => m.type === 'existingAgents')!;
      expect(existing.roleNames).toEqual({});
    } finally {
      runtime2.dispose();
      store2.dispose();
    }
  });
});
