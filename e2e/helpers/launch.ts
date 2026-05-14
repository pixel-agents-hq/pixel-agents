import { _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";

const REPO_ROOT = path.join(__dirname, "../..");
const VSCODE_PATH_FILE = path.join(
  REPO_ROOT,
  ".vscode-test/vscode-executable.txt",
);
const MOCK_CLAUDE_PATH = path.join(REPO_ROOT, "e2e/fixtures/mock-claude");
const MOCK_CLAUDE_CMD_PATH = path.join(
  REPO_ROOT,
  "e2e/fixtures/mock-claude.cmd",
);
const ARTIFACTS_DIR = path.join(REPO_ROOT, "test-results/e2e");
const IS_WINDOWS = process.platform === "win32";
const PATH_SEP = IS_WINDOWS ? ";" : ":";

export interface VSCodeSession {
  app: ElectronApplication;
  window: Page;
  /** Isolated HOME directory for this test session. */
  tmpHome: string;
  /** Workspace directory opened in VS Code. */
  workspaceDir: string;
  /** Path to the mock invocations log. */
  mockLogFile: string;
  cleanup: () => Promise<void>;
}

/**
 * Launch VS Code with the Pixel Agents extension loaded in development mode.
 *
 * Uses an isolated temp HOME and injects the mock `claude` binary at the
 * front of PATH so no real Claude CLI is needed.
 */
export async function launchVSCode(testTitle: string): Promise<VSCodeSession> {
  const vscodePath = fs.readFileSync(VSCODE_PATH_FILE, "utf8").trim();

  // --- Isolated temp directories ---
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-e2e-"));
  const tmpHome = path.join(tmpBase, "home");
  const workspaceDir = path.join(tmpBase, "workspace");
  const userDataDir = path.join(tmpBase, "userdata");
  const mockBinDir = path.join(tmpBase, "bin");

  fs.mkdirSync(tmpHome, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(mockBinDir, { recursive: true });

  // On Windows, os.tmpdir() may return an 8.3 short path (e.g. RUNNER~1) while
  // child processes see the long path (e.g. runneradmin) via %CD%. Normalize to
  // the canonical long path so the project hash computed here matches mock-claude.
  // fs.realpathSync only resolves symlinks; .native uses GetFinalPathNameByHandleW
  // which also resolves 8.3 short names to their full form.
  const resolvedWorkspaceDir = IS_WINDOWS
    ? fs.realpathSync.native(workspaceDir)
    : workspaceDir;

  // macOS: create a temporary keychain so the OS doesn't show "Keychain Not Found" dialog.
  // The isolated HOME has no keychain, and VS Code/Electron's safeStorage triggers a system prompt.
  if (process.platform === "darwin") {
    const keychainDir = path.join(tmpHome, "Library", "Keychains");
    fs.mkdirSync(keychainDir, { recursive: true });
    const keychainPath = path.join(keychainDir, "login.keychain-db");
    try {
      const { execSync } = require("child_process");
      execSync(`security create-keychain -p "" "${keychainPath}"`, {
        stdio: "ignore",
      });
      execSync(`security default-keychain -s "${keychainPath}"`, {
        stdio: "ignore",
        env: { ...process.env, HOME: tmpHome },
      });
    } catch {
      // keychain creation failure is non-fatal, test may still work
    }
  }

  // Copy mock-claude into an isolated bin dir
  if (IS_WINDOWS) {
    // Windows: copy the .cmd batch file as 'claude.cmd'
    fs.copyFileSync(MOCK_CLAUDE_CMD_PATH, path.join(mockBinDir, "claude.cmd"));
  } else {
    const mockDest = path.join(mockBinDir, "claude");
    fs.copyFileSync(MOCK_CLAUDE_PATH, mockDest);
    fs.chmodSync(mockDest, 0o755);
  }

  // macOS: VS Code's integrated terminal resolves PATH from the login shell,
  // ignoring the process env. Define a custom terminal profile that uses a
  // non-login shell with our mock bin dir in PATH. On Linux the process env
  // propagates directly, so no custom profile is needed.
  if (process.platform === "darwin") {
    const userSettingsDir = path.join(userDataDir, "User");
    fs.mkdirSync(userSettingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(userSettingsDir, "settings.json"),
      JSON.stringify(
        {
          "terminal.integrated.profiles.osx": {
            e2e: {
              path: "/bin/zsh",
              args: ["--no-globalrcs"],
              env: {
                PATH: `${mockBinDir}:/usr/local/bin:/usr/bin:/bin`,
                HOME: tmpHome,
                ZDOTDIR: tmpHome,
              },
            },
          },
          "terminal.integrated.defaultProfile.osx": "e2e",
          "terminal.integrated.inheritEnv": false,
        },
        null,
        2,
      ),
    );
  }

  const mockLogFile = path.join(tmpHome, ".claude-mock", "invocations.log");

  // --- Video output dir ---
  const safeTitle = testTitle.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const videoDir = path.join(ARTIFACTS_DIR, "videos", safeTitle);
  fs.mkdirSync(videoDir, { recursive: true });

  // --- Environment for VS Code process ---
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: tmpHome,
    // Prepend mock bin so 'claude' resolves to our mock
    PATH: `${mockBinDir}${PATH_SEP}${process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"}`,
    // Prevent VS Code from trying to talk to real accounts / telemetry
    VSCODE_TELEMETRY_DISABLED: "1",
  };

  // --- VS Code launch args ---
  const args = [
    // Load our extension in dev mode (this overrides the installed version)
    `--extensionDevelopmentPath=${REPO_ROOT}`,
    // Disable all other extensions so tests are isolated
    "--disable-extensions",
    // Isolated user-data (settings, state, etc.)
    `--user-data-dir=${userDataDir}`,
    // Skip interactive prompts
    "--disable-workspace-trust",
    "--skip-release-notes",
    "--skip-welcome",
    "--no-sandbox",
    // Prevent "Code is currently being updated" errors when the host VS Code
    // is mid-update — the test instance must not participate in update checks.
    "--disable-updates",
    // Disable GPU acceleration: prevents Electron GPU-sandbox stalls in headless
    // CI environments (required on macOS arm64 runners, harmless elsewhere).
    "--disable-gpu",
    // On Linux, use the Ozone headless platform so Electron runs without a
    // display server (equivalent to what --disable-gpu achieves on macOS/Windows).
    ...(process.platform === "linux" ? ["--ozone-platform=headless"] : []),
    // Open the workspace folder
    resolvedWorkspaceDir,
  ];

  const cleanup = async (): Promise<void> => {
    try {
      if (app) {
        await app.close();
      }
    } catch {
      // ignore close errors
    }
    // macOS: deregister the temporary keychain to avoid orphaned references
    if (process.platform === "darwin") {
      try {
        const keychainPath = path.join(
          tmpHome,
          "Library",
          "Keychains",
          "login.keychain-db",
        );
        const { execSync } = require("child_process");
        execSync(`security delete-keychain "${keychainPath}"`, {
          stdio: "ignore",
        });
      } catch {
        // keychain may not exist or already be removed
      }
    }
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  };

  let app: ElectronApplication | undefined;

  try {
    // Playwright's video recording freezes VS Code's renderer on Windows,
    // so only enable it on non-Windows platforms.
    const launchOptions: Parameters<typeof electron.launch>[0] = {
      executablePath: vscodePath,
      args,
      env,
      cwd: resolvedWorkspaceDir,
      timeout: 60_000,
    };
    if (!IS_WINDOWS) {
      launchOptions.recordVideo = {
        dir: videoDir,
        size: { width: 1280, height: 800 },
      };
    }

    app = await electron.launch(launchOptions);

    const window = await app.firstWindow();

    // The Ozone headless backend ignores --window-size CLI flags, so VS Code
    // opens at a tiny default size on Linux. Resize via the Electron API after
    // the window exists — getAllWindows() is empty before firstWindow() resolves.
    if (process.platform === "linux") {
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setSize(1280, 800);
      });
      // Give VS Code's layout system time to respond to the resize before tests
      // start measuring panel heights.
      await window.waitForTimeout(500);
    }

    return {
      app,
      window,
      tmpHome,
      workspaceDir: resolvedWorkspaceDir,
      mockLogFile,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Wait for VS Code's workbench to be fully ready before interacting.
 */
export async function waitForWorkbench(window: Page): Promise<void> {
  // VS Code renders a div.monaco-workbench when the shell is ready
  await window.waitForSelector(".monaco-workbench", { timeout: 60_000 });
}
