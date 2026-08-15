import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { areHooksInstalled, getHermesConfigPath, installHooks, makeHookTarget, uninstallHooks } =
  await import('../src/providers/hook/hermes/hermesHookInstaller.js');

const SERVER_URL = 'http://127.0.0.1:48231';
const TOKEN = 'test-token-123';

function readConfig(): Record<string, unknown> {
  const p = getHermesConfigPath();
  return yaml.load(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

describe('hermesHookInstaller', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hermes-hook-test-'));
    process.env.HERMES_CONFIG = path.join(tmpBase, 'hermes', 'config.yaml');
  });

  afterEach(() => {
    delete process.env.HERMES_CONFIG;
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // 1. installHooks adds an entry to hooks.outbound
  it('installHooks adds an entry to hooks.outbound', () => {
    installHooks(SERVER_URL, TOKEN);
    const config = readConfig();
    const hooks = config.hooks as Record<string, unknown[]>;
    expect(Array.isArray(hooks.outbound)).toBe(true);
    expect(hooks.outbound).toHaveLength(1);
    const entry = hooks.outbound[0] as Record<string, unknown>;
    expect(entry.url).toBe(`${SERVER_URL}/api/hooks/hermes`);
    expect(entry.events).toEqual([
      'pre_tool_call',
      'post_tool_call',
      'on_session_start',
      'on_session_end',
      'subagent_start',
      'subagent_stop',
    ]);
    expect(entry.matcher).toBe('.*');
    expect(entry.secret).toBe(TOKEN);
    expect(entry.name).toBe('pixel-agents');
  });

  // 2. installHooks is idempotent
  it('installHooks is idempotent', () => {
    installHooks(SERVER_URL, TOKEN);
    installHooks(SERVER_URL, TOKEN);
    const config = readConfig();
    const outbound = (config.hooks as Record<string, unknown[]>).outbound;
    expect(outbound).toHaveLength(1);
  });

  // 3. areHooksInstalled returns true after install
  it('areHooksInstalled returns true after install', () => {
    installHooks(SERVER_URL, TOKEN);
    expect(areHooksInstalled()).toBe(true);
  });

  // 4. areHooksInstalled returns false before install
  it('areHooksInstalled returns false before install', () => {
    expect(areHooksInstalled()).toBe(false);
  });

  // 5. uninstallHooks removes entries
  it('uninstallHooks removes entries', () => {
    installHooks(SERVER_URL, TOKEN);
    expect(areHooksInstalled()).toBe(true);
    uninstallHooks();
    expect(areHooksInstalled()).toBe(false);
  });

  // 6. uninstallHooks cleans empty hooks object
  it('uninstallHooks cleans empty hooks object', () => {
    installHooks(SERVER_URL, TOKEN);
    uninstallHooks();
    const config = readConfig();
    expect(config.hooks).toBeUndefined();
  });

  // 7. Handles missing config dir/file
  it('handles missing config gracefully', () => {
    expect(() => areHooksInstalled()).not.toThrow();
    expect(areHooksInstalled()).toBe(false);
  });

  // 8. Handles malformed config.yaml
  it('handles malformed config.yaml gracefully', () => {
    fs.mkdirSync(path.dirname(getHermesConfigPath()), { recursive: true });
    fs.writeFileSync(getHermesConfigPath(), '::: not yaml :::');
    expect(() => areHooksInstalled()).not.toThrow();
    expect(areHooksInstalled()).toBe(false);
  });

  // 9. Preserves unrelated config keys (the CRITICAL corruption pitfall)
  it('preserves unrelated config keys when installing', () => {
    fs.mkdirSync(path.dirname(getHermesConfigPath()), { recursive: true });
    fs.writeFileSync(
      getHermesConfigPath(),
      [
        'mcp_servers:',
        '  pencil:',
        '    command: "D:\\\\bin\\\\pen.exe"',
        '    args: ["--app", "desktop"]',
        '    env: {}',
        'model: deepseek-v4-flash',
        '',
      ].join('\n'),
    );
    installHooks(SERVER_URL, TOKEN);
    const config = readConfig();
    expect(config.model).toBe('deepseek-v4-flash');
    const pencil = (config.mcp_servers as Record<string, unknown>).pencil as Record<
      string,
      unknown
    >;
    expect(pencil.command).toBe('D:\\bin\\pen.exe');
    expect((config.hooks as Record<string, unknown[]>).outbound).toHaveLength(1);
  });

  // 10. Preserves other users' outbound webhook entries
  it('preserves other outbound webhook entries', () => {
    fs.mkdirSync(path.dirname(getHermesConfigPath()), { recursive: true });
    fs.writeFileSync(
      getHermesConfigPath(),
      [
        'hooks:',
        '  outbound:',
        '    - url: https://ci.example.com/hermes-events',
        '      events: [on_session_end]',
        '      name: ci-notify',
        '',
      ].join('\n'),
    );
    installHooks(SERVER_URL, TOKEN);
    const config = readConfig();
    const outbound = (config.hooks as Record<string, unknown[]>).outbound;
    expect(outbound).toHaveLength(2);
    expect((outbound[0] as Record<string, unknown>).name).toBe('ci-notify');
    expect((outbound[1] as Record<string, unknown>).name).toBe('pixel-agents');
  });

  // 11. uninstallHooks leaves other users' entries untouched
  it('uninstallHooks leaves other outbound entries untouched', () => {
    fs.mkdirSync(path.dirname(getHermesConfigPath()), { recursive: true });
    fs.writeFileSync(
      getHermesConfigPath(),
      [
        'hooks:',
        '  outbound:',
        '    - url: https://ci.example.com/hermes-events',
        '      events: [on_session_end]',
        '      name: ci-notify',
        '',
      ].join('\n'),
    );
    installHooks(SERVER_URL, TOKEN);
    uninstallHooks();
    const config = readConfig();
    const outbound = (config.hooks as Record<string, unknown[]>).outbound;
    expect(outbound).toHaveLength(1);
    expect((outbound[0] as Record<string, unknown>).name).toBe('ci-notify');
  });

  // 12. makeHookTarget builds a url rooted at the server URL + provider path
  it('makeHookTarget normalizes trailing slashes in serverUrl', () => {
    const target = makeHookTarget('http://127.0.0.1:48231/', TOKEN) as Record<string, unknown>;
    expect(target.url).toBe('http://127.0.0.1:48231/api/hooks/hermes');
  });

  // 13. getHermesConfigPath honors $HERMES_CONFIG over ~/.hermes/config.yaml
  it('getHermesConfigPath prefers $HERMES_CONFIG', () => {
    const fromEnv = path.join(tmpBase, 'custom', 'config.yaml');
    process.env.HERMES_CONFIG = fromEnv;
    expect(getHermesConfigPath()).toBe(fromEnv);
  });
});
