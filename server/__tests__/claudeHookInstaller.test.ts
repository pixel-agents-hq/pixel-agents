import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpBase: string;

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return { ...actual, homedir: () => tmpBase };
});

const { areHooksInstalled, installHooks, uninstallHooks, copyHookScript } =
  await import("../src/providers/hook/claude/claudeHookInstaller.js");

function readSettings(): Record<string, unknown> {
  const p = path.join(tmpBase, ".claude", "settings.json");
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

describe("claudeHookInstaller", () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "pxl-hook-test-"));
    fs.mkdirSync(path.join(tmpBase, ".claude"), { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // 1. installHooks adds entries
  it("installHooks adds entries to settings.json", () => {
    installHooks();
    const settings = readSettings();
    expect(settings.hooks).toBeTruthy();
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks["Notification"]).toHaveLength(1);
    expect(hooks["Stop"]).toHaveLength(1);
    expect(hooks["PermissionRequest"]).toHaveLength(1);
  });

  // 2. installHooks is idempotent
  it("installHooks is idempotent", () => {
    installHooks();
    installHooks();
    const hooks = readSettings().hooks as Record<string, unknown[]>;
    expect(hooks["Notification"]).toHaveLength(1);
    expect(hooks["Stop"]).toHaveLength(1);
    expect(hooks["PermissionRequest"]).toHaveLength(1);
  });

  // 3. areHooksInstalled returns true after install
  it("areHooksInstalled returns true after install", () => {
    installHooks();
    expect(areHooksInstalled()).toBe(true);
  });

  // 4. areHooksInstalled returns false before install
  it("areHooksInstalled returns false before install", () => {
    expect(areHooksInstalled()).toBe(false);
  });

  // 5. uninstallHooks removes entries
  it("uninstallHooks removes entries", () => {
    installHooks();
    expect(areHooksInstalled()).toBe(true);
    uninstallHooks();
    expect(areHooksInstalled()).toBe(false);
  });

  // 6. uninstallHooks cleans empty hooks object
  it("uninstallHooks cleans empty hooks object", () => {
    installHooks();
    uninstallHooks();
    const settings = readSettings();
    expect(settings.hooks).toBeUndefined();
  });

  // 7. Handles missing settings.json
  it("handles missing settings.json gracefully", () => {
    expect(() => areHooksInstalled()).not.toThrow();
    expect(areHooksInstalled()).toBe(false);
  });

  // 8. Handles malformed settings.json
  it("handles malformed settings.json gracefully", () => {
    fs.writeFileSync(
      path.join(tmpBase, ".claude", "settings.json"),
      "not json!!!",
    );
    expect(() => areHooksInstalled()).not.toThrow();
    expect(areHooksInstalled()).toBe(false);
  });

  // 9. copyHookScript copies file
  it("copyHookScript copies to ~/.pixel-agents/hooks/", () => {
    // Create a mock extension path with dist/hooks/claude-hook.js
    const mockExtPath = path.join(tmpBase, "mock-ext");
    const hookSrc = path.join(mockExtPath, "dist", "hooks");
    fs.mkdirSync(hookSrc, { recursive: true });
    fs.writeFileSync(
      path.join(hookSrc, "claude-hook.js"),
      "// mock hook script",
    );

    copyHookScript(mockExtPath);

    const dst = path.join(tmpBase, ".pixel-agents", "hooks", "claude-hook.js");
    expect(fs.existsSync(dst)).toBe(true);
    expect(fs.readFileSync(dst, "utf-8")).toBe("// mock hook script");
  });

  // 10. copyHookScript sets executable permissions (non-Windows)
  it("copyHookScript sets executable permissions", () => {
    if (process.platform === "win32") return; // chmod not meaningful on Windows

    const mockExtPath = path.join(tmpBase, "mock-ext");
    const hookSrc = path.join(mockExtPath, "dist", "hooks");
    fs.mkdirSync(hookSrc, { recursive: true });
    fs.writeFileSync(path.join(hookSrc, "claude-hook.js"), "// mock");

    copyHookScript(mockExtPath);

    const dst = path.join(tmpBase, ".pixel-agents", "hooks", "claude-hook.js");
    const stat = fs.statSync(dst);
    // Check owner execute bit
    expect(stat.mode & 0o100).toBeTruthy();
  });
});
