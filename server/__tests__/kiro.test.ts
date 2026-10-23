import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { kiroProvider, normalizeKiroHookEvent } from '../src/providers/hook/kiro/kiro.js';
import { makeKiroHookPayload } from '../src/providers/hook/kiro/kiroHookPayload.js';

let tmpBase: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const {
  areKiroHooksInstalled,
  installKiroHooks,
  uninstallKiroHooks,
  makeKiroProfile,
  copyKiroHookScript,
} = await import('../src/providers/hook/kiro/kiroHookInstaller.js');

function profilePath(): string {
  return path.join(tmpBase, '.kiro', 'agents', 'pixel-agents-office.json');
}

describe('Kiro provider', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-kiro-provider-'));
    fs.mkdirSync(path.join(tmpBase, '.pixel-agents', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(tmpBase, '.pixel-agents', 'hooks', 'kiro-hook.js'), '// test');
  });
  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('uses the interactive V3 CLI with normal tool approvals and a local routing id', async () => {
    await installKiroHooks();
    const command = kiroProvider.buildLaunchCommand?.('office-id', '/project', {
      bypassPermissions: true,
    });
    expect(command?.args).toEqual(['chat', '--v3', '--agent', 'pixel-agents-office']);
    expect(command?.env?.PIXEL_AGENTS_KIRO_SESSION_ID).toBe('office-id');
    expect(command?.args.join(' ')).not.toMatch(/trust|skip-permissions|no-interactive/);
    expect(kiroProvider.getSessionDirs).toBeUndefined();
    expect(kiroProvider.subagentToolNames.size).toBe(0);
  });

  it('requires the explicitly approved Kiro profile before a launch', () => {
    expect(() => kiroProvider.buildLaunchCommand?.('id', '/project')).toThrow(
      'Enable Kiro Instant Detection',
    );
  });

  it('normalizes only observed session and coarse tool events', () => {
    const base = { session_id: 'actual-session', cwd: '/project' };
    expect(normalizeKiroHookEvent({ ...base, hook_event_name: 'SessionStart' })?.event).toEqual({
      kind: 'sessionStart',
      cwd: '/project',
    });
    expect(
      normalizeKiroHookEvent({
        ...base,
        hook_event_name: 'PreToolUse',
        tool_name: 'fs_read',
        tool_input: { path: 'main.ts' },
      })?.event,
    ).toEqual({
      kind: 'toolStart',
      toolId: 'current',
      toolName: 'fs_read',
      input: { path: 'main.ts' },
    });
    expect(normalizeKiroHookEvent({ ...base, hook_event_name: 'PostToolUse' })?.event).toEqual({
      kind: 'toolEnd',
      toolId: 'current',
    });
    expect(normalizeKiroHookEvent({ ...base, hook_event_name: 'Stop' })?.event).toEqual({
      kind: 'turnEnd',
    });
    expect(normalizeKiroHookEvent({ ...base, hook_event_name: 'PermissionRequest' })).toBeNull();
    expect(normalizeKiroHookEvent({ ...base, hook_event_name: 'SubagentStart' })).toBeNull();
    expect(normalizeKiroHookEvent({ hook_event_name: 'Stop' })).toBeNull();
  });

  it('reports a real submitted turn without forwarding prompt text', () => {
    const payload = makeKiroHookPayload(
      {
        session_id: 'kiro-id',
        prompt: 'private prompt',
        response: 'private response',
        token: 'secret',
        cwd: '/project',
      },
      'UserPromptSubmit',
      'office-id',
    );
    expect(payload).toEqual({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'office-id',
      cwd: '/project',
    });
    expect(normalizeKiroHookEvent(payload!)?.event).toEqual({
      kind: 'toolStart',
      toolId: 'kiro-turn',
      toolName: 'thinking',
    });
  });

  it('forwards tool inputs only for starts and never tool outputs', () => {
    const raw = {
      session_id: 'kiro-id',
      tool_name: 'fs_read',
      tool_input: { path: 'main.ts' },
      tool_output: 'private content',
    };
    expect(makeKiroHookPayload(raw, 'PreToolUse')).toEqual({
      hook_event_name: 'PreToolUse',
      session_id: 'kiro-id',
      tool_name: 'fs_read',
      tool_input: { path: 'main.ts' },
    });
    expect(makeKiroHookPayload(raw, 'PostToolUse')).toEqual({
      hook_event_name: 'PostToolUse',
      session_id: 'kiro-id',
      tool_name: 'fs_read',
    });
    expect(makeKiroHookPayload(raw, 'Unknown')).toBeNull();
    expect(makeKiroHookPayload(null, 'Stop')).toBeNull();
  });

  it('formats native Kiro tool names and classifies read animations', () => {
    expect(kiroProvider.formatToolStatus('fs_read', { path: '/project/main.ts' })).toBe(
      'Reading main.ts',
    );
    expect(kiroProvider.formatToolStatus('execute_bash', { command: 'npm test' })).toBe(
      'Running: npm test',
    );
    expect(kiroProvider.readingTools.has('fs_read')).toBe(true);
    expect(kiroProvider.readingTools.has('execute_bash')).toBe(false);
  });
});

describe('Kiro dedicated profile installer', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-kiro-installer-'));
    const hookDir = path.join(tmpBase, '.pixel-agents', 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, 'kiro-hook.js'), '// isolated test hook');
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('creates only its dedicated profile, is idempotent, and removes it cleanly', async () => {
    const userProfile = path.join(tmpBase, '.kiro', 'agents', 'personal.json');
    fs.mkdirSync(path.dirname(userProfile), { recursive: true });
    fs.writeFileSync(userProfile, '{"name":"personal"}');
    await installKiroHooks();
    const original = fs.readFileSync(profilePath(), 'utf8');
    await installKiroHooks();
    expect(fs.readFileSync(profilePath(), 'utf8')).toBe(original);
    expect(await areKiroHooksInstalled()).toBe(true);
    const profile = JSON.parse(original);
    expect(profile.tools).toEqual(['@builtin']);
    expect(profile.permissions).toEqual({ rules: [] });
    expect(profile.model).toBeUndefined();
    expect(profile.allowedTools).toBeUndefined();
    expect(profile.hooks.map((hook: { trigger: string }) => hook.trigger)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'SessionEnd',
    ]);
    await uninstallKiroHooks();
    expect(await areKiroHooksInstalled()).toBe(false);
    expect(fs.readFileSync(userProfile, 'utf8')).toBe('{"name":"personal"}');
  });

  it('refuses to overwrite or remove an unrelated profile with the same filename', async () => {
    fs.mkdirSync(path.dirname(profilePath()), { recursive: true });
    const original = '{"name":"my own profile","permissions":{"rules":["personal"]}}';
    fs.writeFileSync(profilePath(), original);
    await expect(installKiroHooks()).rejects.toThrow('not overwritten');
    await expect(uninstallKiroHooks()).rejects.toThrow('not removed');
    expect(await areKiroHooksInstalled()).toBe(false);
    expect(fs.readFileSync(profilePath(), 'utf8')).toBe(original);
  });

  it('preserves an edited managed profile and malformed JSON', async () => {
    await installKiroHooks();
    const edited = { ...makeKiroProfile(), prompt: 'User customization' };
    fs.writeFileSync(profilePath(), JSON.stringify(edited));
    await expect(uninstallKiroHooks()).rejects.toThrow('not removed');
    fs.writeFileSync(profilePath(), 'not json');
    await expect(installKiroHooks()).rejects.toThrow('left unchanged');
    expect(fs.readFileSync(profilePath(), 'utf8')).toBe('not json');
  });

  it('does not install entries pointing to a missing hook script', async () => {
    fs.unlinkSync(path.join(tmpBase, '.pixel-agents', 'hooks', 'kiro-hook.js'));
    await expect(installKiroHooks()).rejects.toThrow('script is missing');
    expect(fs.existsSync(profilePath())).toBe(false);
  });

  it.skipIf(!fs.existsSync(path.join(__dirname, '../../dist/hooks/kiro-hook.js')))(
    'executes the generated hook command through the native shell with paths containing spaces',
    async () => {
      const actualScript = path.join(__dirname, '../../dist/hooks/kiro-hook.js');
      fs.copyFileSync(actualScript, path.join(tmpBase, '.pixel-agents', 'hooks', 'kiro-hook.js'));
      const command = makeKiroProfile().hooks[0].action.command;
      const shell = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
      const args =
        process.platform === 'win32' ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command];
      const result = await new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          const child = spawn(shell, args, {
            env: {
              ...process.env,
              HOME: tmpBase,
              USERPROFILE: tmpBase,
              PIXEL_AGENTS_KIRO_SESSION_ID: 'shell-test',
            },
            windowsHide: true,
            windowsVerbatimArguments: process.platform === 'win32',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5000,
          });
          let output = '';
          child.stdout.on('data', (chunk: Buffer) => {
            output += chunk;
          });
          child.stderr.on('data', (chunk: Buffer) => {
            output += chunk;
          });
          child.on('error', reject);
          child.on('close', (code) => resolve({ code, output }));
          child.stdin.end('{"session_id":"native-test"}');
        },
      );
      expect(result).toEqual({ code: 0, output: '' });
    },
  );

  it('copies the bundled Kiro hook before installing the profile', async () => {
    const bundleDir = path.join(tmpBase, 'package', 'dist', 'hooks');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'kiro-hook.js'), '// bundled hook');
    expect(copyKiroHookScript(path.join(tmpBase, 'package'))).toBe(true);
    await installKiroHooks();
    expect(await areKiroHooksInstalled()).toBe(true);
  });
});
