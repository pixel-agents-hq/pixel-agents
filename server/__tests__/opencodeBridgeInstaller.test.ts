import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;
let fakePackageRoot: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const {
  areHooksInstalled,
  installBridgePlugin,
  installHooks,
  uninstallHooks,
  bridgeForeignFileMessage,
} = await import('../src/providers/hook/opencode/opencodeBridgeInstaller.js');
const { OPENCODE_PLUGIN_FILE_NAME, OPENCODE_PLUGIN_MARKER } =
  await import('../src/providers/hook/opencode/constants.js');

/** Real bridge source in the source tree, staged into the fake package root
 *  the way the build stages it into dist/bridge/. */
const REAL_BRIDGE_SOURCE = fileURLToPath(
  new URL('../src/providers/hook/opencode/bridge/pixel-agents-bridge.ts', import.meta.url),
);

function pluginPathFor(): string {
  return path.join(tmpBase, '.config', 'opencode', 'plugins', OPENCODE_PLUGIN_FILE_NAME);
}

function stageBridgeSource(): void {
  const dst = path.join(fakePackageRoot, 'dist', 'bridge', 'pixel-agents-bridge.ts');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(REAL_BRIDGE_SOURCE, dst);
}

describe('opencodeBridgeInstaller', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-opencode-test-'));
    fakePackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-opencode-pkg-'));
    stageBridgeSource();
  });

  afterEach(() => {
    for (const dir of [tmpBase, fakePackageRoot]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('installBridgePlugin copies the bridge with the marker; installHooks resolves', async () => {
    expect(areHooksInstalled()).toBe(false);
    expect(installBridgePlugin(fakePackageRoot)).toBe(true);
    const content = fs.readFileSync(pluginPathFor(), 'utf-8');
    expect(content).toContain(OPENCODE_PLUGIN_MARKER);
    expect(areHooksInstalled()).toBe(true);
    await expect(installHooks()).resolves.toBeUndefined();
  });

  it('installBridgePlugin is idempotent', () => {
    expect(installBridgePlugin(fakePackageRoot)).toBe(true);
    const first = fs.readFileSync(pluginPathFor(), 'utf-8');
    expect(installBridgePlugin(fakePackageRoot)).toBe(true);
    expect(fs.readFileSync(pluginPathFor(), 'utf-8')).toBe(first);
    expect(areHooksInstalled()).toBe(true);
  });

  it('refuses a foreign file at the destination and reports not installed', async () => {
    const dst = pluginPathFor();
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, '// my own opencode plugin\nexport const Mine = async () => ({});\n');
    expect(installBridgePlugin(fakePackageRoot)).toBe(false);
    expect(fs.readFileSync(dst, 'utf-8')).toContain('my own opencode plugin');
    expect(areHooksInstalled()).toBe(false);
    await expect(installHooks()).rejects.toThrow();
  });

  it('returns false when the bridge source is missing', () => {
    fs.rmSync(path.join(fakePackageRoot, 'dist'), { recursive: true, force: true });
    expect(installBridgePlugin(fakePackageRoot)).toBe(false);
    expect(areHooksInstalled()).toBe(false);
  });

  it('uninstallHooks removes our plugin and is a silent no-op when absent', async () => {
    await expect(uninstallHooks()).resolves.toBeUndefined();
    expect(installBridgePlugin(fakePackageRoot)).toBe(true);
    await expect(uninstallHooks()).resolves.toBeUndefined();
    expect(fs.existsSync(pluginPathFor())).toBe(false);
    expect(areHooksInstalled()).toBe(false);
  });

  it('uninstallHooks refuses a foreign file', async () => {
    const dst = pluginPathFor();
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, '// mine\n');
    await expect(uninstallHooks()).rejects.toThrow(bridgeForeignFileMessage(dst));
    expect(fs.readFileSync(dst, 'utf-8')).toBe('// mine\n');
  });
});
