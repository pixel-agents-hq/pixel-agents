import * as fs from 'fs';
import yaml from 'js-yaml';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { areHooksInstalled, installHooks, uninstallHooks } =
  await import('../src/providers/hook/hermes/hermesHookInstaller.js');

const CONFIG_PATH = () => path.join(tmpBase, '.hermes', 'config.yaml');

function readConfig(): Record<string, unknown> {
  return yaml.load(fs.readFileSync(CONFIG_PATH(), 'utf-8')) as Record<string, unknown>;
}

describe('hermesHookInstaller', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hermes-test-'));
    fs.mkdirSync(path.join(tmpBase, '.hermes'), { recursive: true });
    // Minimal config.yaml
    fs.writeFileSync(CONFIG_PATH(), 'hooks: {}\n', 'utf-8');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('installHooks adds entries for all 5 events', async () => {
    await installHooks('http://127.0.0.1:3100', 'token');
    const cfg = readConfig();
    const hooks = cfg.hooks as Record<string, unknown[]>;
    expect(hooks['pre_tool_call']).toHaveLength(1);
    expect(hooks['post_tool_call']).toHaveLength(1);
    expect(hooks['post_llm_call']).toHaveLength(1);
    expect(hooks['on_session_start']).toHaveLength(1);
    expect(hooks['on_session_end']).toHaveLength(1);
  });

  it('installHooks is idempotent', async () => {
    await installHooks('http://127.0.0.1:3100', 'token');
    await installHooks('http://127.0.0.1:3100', 'token');
    const hooks = readConfig().hooks as Record<string, unknown[]>;
    expect(hooks['pre_tool_call']).toHaveLength(1);
  });

  it('areHooksInstalled returns true after install', async () => {
    await installHooks('http://127.0.0.1:3100', 'token');
    expect(await areHooksInstalled()).toBe(true);
  });

  it('areHooksInstalled returns false when config has empty hooks', async () => {
    expect(await areHooksInstalled()).toBe(false);
  });

  it('areHooksInstalled returns false when config.yaml is missing', async () => {
    fs.unlinkSync(CONFIG_PATH());
    expect(await areHooksInstalled()).toBe(false);
  });

  it('uninstallHooks removes pixel-agents entries', async () => {
    await installHooks('http://127.0.0.1:3100', 'token');
    expect(await areHooksInstalled()).toBe(true);
    await uninstallHooks();
    expect(await areHooksInstalled()).toBe(false);
  });

  it('uninstallHooks preserves other user hook entries', async () => {
    // Pre-existing user hook
    fs.writeFileSync(
      CONFIG_PATH(),
      yaml.dump({
        hooks: {
          pre_tool_call: [{ command: 'echo user-hook', timeout: 5 }],
        },
      }),
      'utf-8',
    );
    await installHooks('http://127.0.0.1:3100', 'token');
    await uninstallHooks();
    const hooks = readConfig().hooks as Record<string, unknown[]>;
    expect(hooks['pre_tool_call']).toHaveLength(1);
    expect((hooks['pre_tool_call'][0] as Record<string, unknown>).command).toBe('echo user-hook');
  });

  it('installHooks creates config.yaml if missing', async () => {
    fs.unlinkSync(CONFIG_PATH());
    await installHooks('http://127.0.0.1:3100', 'token');
    expect(fs.existsSync(CONFIG_PATH())).toBe(true);
    expect(await areHooksInstalled()).toBe(true);
  });
});
