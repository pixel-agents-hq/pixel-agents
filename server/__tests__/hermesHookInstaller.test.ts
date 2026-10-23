import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

import {
  HERMES_HOOK_EVENTS,
  HERMES_HOOK_URL_PATH,
  HERMES_OUTBOUND_ENTRY_NAME,
} from '../src/providers/hook/hermes/constants';
import {
  areHooksInstalled,
  buildHermesHookUrl,
  getHermesConfigPath,
  HERMES_CONFIG_UNPARSEABLE_MESSAGE,
  HERMES_HOOKS_NOT_OBJECT_MESSAGE,
  HERMES_OUTBOUND_NOT_ARRAY_MESSAGE,
  installHooks,
  uninstallHooks,
} from '../src/providers/hook/hermes/hermesHookInstaller';

const USER_CONFIG = [
  '# my precious comment',
  'model:',
  '  default: qwen3.6-35b-a3b',
  'terminal:',
  '  backend: local',
  'hooks:',
  '  outbound:',
  '    - name: ci-notify',
  '      url: https://ci.example.com/hermes-events',
  '      events:',
  '        - on_session_end',
  '      secret_env: CI_WEBHOOK_SECRET',
  '',
].join('\n');

describe('hermesHookInstaller', () => {
  let tempHome: string;
  let originalHermesHome: string | undefined;

  function configPath(): string {
    return path.join(tempHome, 'config.yaml');
  }
  function readConfig(): string {
    return fs.readFileSync(configPath(), 'utf8');
  }
  function outbound(): Array<Record<string, unknown>> {
    const doc = parseDocument(readConfig());
    return (doc.toJS() as { hooks?: { outbound?: Array<Record<string, unknown>> } }).hooks
      ?.outbound as Array<Record<string, unknown>>;
  }
  function ours(): Array<Record<string, unknown>> {
    return outbound().filter((e) => e.name === HERMES_OUTBOUND_ENTRY_NAME);
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hermes-installer-'));
    originalHermesHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = tempHome;
  });

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHermesHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe('buildHermesHookUrl', () => {
    it('appends the provider path and encodes the token query', () => {
      expect(buildHermesHookUrl('http://127.0.0.1:3100/', 'a&b c')).toBe(
        `http://127.0.0.1:3100${HERMES_HOOK_URL_PATH}?token=a%26b%20c`,
      );
    });
  });

  describe('install', () => {
    it('creates config.yaml inside the home when absent, with no backup of nothing', async () => {
      await installHooks('http://127.0.0.1:4100', 'tok-1');
      expect(fs.existsSync(configPath())).toBe(true);
      expect(fs.existsSync(configPath() + '.pixel-agents.backup')).toBe(false);
      expect(areHooksInstalled()).toBe(true);
    });

    it('writes the canonical entry: name, url+token, the exact event list, timeout', async () => {
      fs.writeFileSync(configPath(), 'model:\n  default: x\n');
      await installHooks('http://127.0.0.1:4100', 'tok-1');
      expect(ours()).toEqual([
        {
          name: HERMES_OUTBOUND_ENTRY_NAME,
          url: `http://127.0.0.1:4100${HERMES_HOOK_URL_PATH}?token=tok-1`,
          events: [...HERMES_HOOK_EVENTS],
          timeout: 5,
        },
      ]);
    });

    it('preserves the user model/terminal keys and a foreign outbound target', async () => {
      fs.writeFileSync(configPath(), USER_CONFIG);
      await installHooks('http://127.0.0.1:4100', 'tok-1');
      const js = parseDocument(readConfig()).toJS() as {
        model: { default: string };
        terminal: { backend: string };
      };
      expect(js.model.default).toBe('qwen3.6-35b-a3b');
      expect(js.terminal.backend).toBe('local');
      const foreign = outbound().filter((e) => e.name === 'ci-notify');
      expect(foreign).toHaveLength(1);
      expect(foreign[0].url).toBe('https://ci.example.com/hermes-events');
    });

    it('is idempotent and re-points port+token on reinstall (fresh boot rotation)', async () => {
      fs.writeFileSync(configPath(), 'model:\n  default: x\n');
      await installHooks('http://127.0.0.1:4100', 'tok-1');
      await installHooks('http://127.0.0.1:9999', 'tok-2');
      expect(ours()).toHaveLength(1);
      expect(ours()[0].url).toContain(':9999');
      expect(ours()[0].url).toContain('token=tok-2');
    });

    it('collapses hand-duplicated copies of our entry into one', async () => {
      fs.writeFileSync(
        configPath(),
        `hooks:\n  outbound:\n    - name: pixel-agents\n      url: http://127.0.0.1:1${HERMES_HOOK_URL_PATH}?token=a\n    - name: copy-paste\n      url: http://127.0.0.1:2${HERMES_HOOK_URL_PATH}?token=b\n`,
      );
      await installHooks('http://127.0.0.1:4100', 'tok');
      expect(outbound()).toHaveLength(1);
      expect(outbound()[0].name).toBe(HERMES_OUTBOUND_ENTRY_NAME);
    });

    it('makes the branded one-time backup before first touch and never overwrites it', async () => {
      fs.writeFileSync(configPath(), USER_CONFIG);
      await installHooks('http://127.0.0.1:4100', 'tok-1');
      const backup = configPath() + '.pixel-agents.backup';
      expect(fs.readFileSync(backup, 'utf8')).toBe(USER_CONFIG);
      fs.writeFileSync(configPath(), USER_CONFIG + '\nx: 1\n');
      await installHooks('http://127.0.0.1:4100', 'tok-2');
      // The backup still holds the FIRST original, not the second install's input.
      expect(fs.readFileSync(backup, 'utf8')).toBe(USER_CONFIG);
    });

    it('refuses an unparseable config and writes nothing', async () => {
      const broken = 'hooks:\n  outbound: [unclosed\n';
      fs.writeFileSync(configPath(), broken);
      await expect(installHooks('http://127.0.0.1:4100', 'tok')).rejects.toThrow(
        HERMES_CONFIG_UNPARSEABLE_MESSAGE,
      );
      expect(readConfig()).toBe(broken);
    });

    it('refuses to rewrite a non-mapping hooks key', async () => {
      const bad = 'hooks: "not a mapping"\n';
      fs.writeFileSync(configPath(), bad);
      await expect(installHooks('http://127.0.0.1:4100', 'tok')).rejects.toThrow(
        HERMES_HOOKS_NOT_OBJECT_MESSAGE,
      );
      expect(readConfig()).toBe(bad);
    });

    it('refuses a non-list outbound instead of silently replacing user data', async () => {
      const bad = 'hooks:\n  outbound: "oops"\n';
      fs.writeFileSync(configPath(), bad);
      await expect(installHooks('http://127.0.0.1:4100', 'tok')).rejects.toThrow(
        HERMES_OUTBOUND_NOT_ARRAY_MESSAGE,
      );
      expect(readConfig()).toBe(bad);
    });

    it('refuses a scalar entry inside outbound', async () => {
      const bad = 'hooks:\n  outbound:\n    - just-a-string\n';
      fs.writeFileSync(configPath(), bad);
      await expect(installHooks('http://127.0.0.1:4100', 'tok')).rejects.toThrow(/outbound\[0\]/);
      expect(readConfig()).toBe(bad);
    });
  });

  describe('areHooksInstalled', () => {
    it('is false when no config exists', () => {
      expect(areHooksInstalled()).toBe(false);
    });
    it('recognizes our entry by url even under a foreign name', async () => {
      fs.writeFileSync(
        configPath(),
        `hooks:\n  outbound:\n    - name: renamed-by-user\n      url: http://127.0.0.1:7${HERMES_HOOK_URL_PATH}?token=x\n      events: [pre_tool_call]\n`,
      );
      expect(areHooksInstalled()).toBe(true);
    });
    it('never claims a foreign target (path must be anchored, not substring of host)', () => {
      fs.writeFileSync(
        configPath(),
        `hooks:\n  outbound:\n    - name: other\n      url: http://example.com/api/hooks/hermesother\n      events: [pre_tool_call]\n`,
      );
      expect(areHooksInstalled()).toBe(false);
    });
    it('degrades to false on malformed-but-foreign shapes rather than throwing through the gate', () => {
      fs.writeFileSync(configPath(), 'hooks:\n  outbound: "oops"\n');
      expect(areHooksInstalled()).toBe(false);
    });
  });

  describe('uninstall', () => {
    it('removes only our entry and keeps the foreign target', async () => {
      fs.writeFileSync(configPath(), USER_CONFIG);
      await installHooks('http://127.0.0.1:4100', 'tok');
      await uninstallHooks();
      expect(areHooksInstalled()).toBe(false);
      const js = parseDocument(readConfig()).toJS() as {
        hooks: { outbound: Array<Record<string, unknown>> };
      };
      expect(js.hooks.outbound).toHaveLength(1);
      expect(js.hooks.outbound[0].name).toBe('ci-notify');
    });

    it('prunes the outbound key, then the hooks key, when it empties them', async () => {
      fs.writeFileSync(configPath(), 'model:\n  default: x\n');
      await installHooks('http://127.0.0.1:4100', 'tok');
      await uninstallHooks();
      const js = parseDocument(readConfig()).toJS() as Record<string, unknown>;
      expect(js.hooks).toBeUndefined();
      expect(js.model).toEqual({ default: 'x' });
    });

    it('is a no-op when nothing of ours is installed', async () => {
      fs.writeFileSync(configPath(), 'model:\n  default: x\n');
      await uninstallHooks();
      expect(parseDocument(readConfig()).toJS()).toEqual({ model: { default: 'x' } });
    });

    it('refuses an unparseable file', async () => {
      fs.writeFileSync(configPath(), 'hooks:\n  outbound: [unclosed\n');
      await expect(uninstallHooks()).rejects.toThrow(HERMES_CONFIG_UNPARSEABLE_MESSAGE);
    });
  });

  describe('getHermesConfigPath resolution', () => {
    it('prefers HERMES_HOME verbatim when set', () => {
      expect(getHermesConfigPath()).toBe(path.join(tempHome, 'config.yaml'));
    });
    it('falls back to the platform default when HERMES_HOME is blank', () => {
      process.env.HERMES_HOME = '  ';
      const expected =
        process.platform === 'win32'
          ? path
              .join(
                process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
                'hermes',
              )
              .toLowerCase()
          : path.join(os.homedir(), '.hermes').toLowerCase();
      expect(getHermesConfigPath().toLowerCase().startsWith(expected.toLowerCase())).toBe(true);
    });
  });
});
