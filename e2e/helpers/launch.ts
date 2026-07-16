import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { namespaceE2EPath } from '../run-config';
import { applyMockHomeEnv } from './mock-claude';

const REPO_ROOT = path.join(__dirname, '../..');
const VSCODE_PATH_FILE = path.join(REPO_ROOT, '.vscode-test/vscode-executable.txt');
const MOCK_CLAUDE_PATH = path.join(REPO_ROOT, 'e2e/fixtures/mock-claude');
const MOCK_CLAUDE_CMD_PATH = path.join(REPO_ROOT, 'e2e/fixtures/mock-claude.cmd');
const MOCK_CLAUDE_RUNNER_PATH = path.join(REPO_ROOT, 'e2e/fixtures/mock-claude-runner.cjs');
const TAIL_FOLLOW_PATH = path.join(REPO_ROOT, 'e2e/fixtures/tail-follow.cjs');
const ARTIFACTS_DIR = namespaceE2EPath(path.join(REPO_ROOT, 'test-results/e2e'));
const IS_WINDOWS = process.platform === 'win32';
const PATH_SEP = IS_WINDOWS ? ';' : ':';

export interface VSCodeSession {
  app: ElectronApplication;
  window: Page;
  /** Isolated HOME directory for this test session. */
  tmpHome: string;
  /** Workspace directory opened in VS Code. */
  workspaceDir: string;
  /** Path to the mock invocations log. */
  mockLogFile: string;
  /** Raw Playwright video directory for this test run, if recording is enabled. */
  videoDir?: string;
  cleanup: () => Promise<void>;
}

/** Optional launch knobs for tests that need a seeded HOME or a multi-root window. */
export interface LaunchOptions {
  /**
   * Folder basenames to open as a multi-root workspace. When length > 1, a
   * `.code-workspace` listing these (as subdirs of the workspace) is opened
   * instead of a single folder, so `vscode.workspace.workspaceFolders.length > 1`
   * and agents launched per-folder get a `folderName`. Length <= 1 is ignored
   * (single-folder default is unchanged).
   */
  workspaceFolders?: string[];
  /** Pre-seed `~/.pixel-agents/config.json` (written before the server reads it). */
  seedConfig?: unknown;
  /** Pre-seed `~/.pixel-agents/layout.json` (written before the panel loads). */
  seedLayout?: unknown;
}

/**
 * Launch VS Code with the Pixel Agents extension loaded in development mode.
 *
 * Uses an isolated temp HOME and injects the mock `claude` binary at the
 * front of PATH so no real Claude CLI is needed.
 */
export async function launchVSCode(
  testTitle: string,
  opts: LaunchOptions = {},
): Promise<VSCodeSession> {
  const vscodePath = fs.readFileSync(VSCODE_PATH_FILE, 'utf8').trim();

  // --- Isolated temp directories ---
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-e2e-'));
  const tmpHome = path.join(tmpBase, 'home');
  const workspaceDir = path.join(tmpBase, 'workspace');
  const userDataDir = path.join(tmpBase, 'userdata');
  const mockBinDir = path.join(tmpBase, 'bin');

  fs.mkdirSync(tmpHome, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(mockBinDir, { recursive: true });

  // Pre-seed user-level config/layout under the isolated HOME, BEFORE VS Code
  // launches — the server reads ~/.pixel-agents/{config,layout}.json on startup,
  // so a test that needs specific areaMappings / showAreas / a known layout must
  // write them now. layout.json must carry a high layoutRevision to survive the
  // bundled-default reset gate (server/src/layoutPersistence.ts).
  //
  // config.json is ALWAYS seeded: every test wants alwaysShowLabels on (overlay
  // text is only assertable when labels render without hover), so the e2e
  // baseline enables it in both namespaces instead of each test clicking
  // through the Settings modal. Missing keys are filled with product defaults
  // by server/src/configPersistence.ts. Tests override via opts.seedConfig
  // (buildSeedConfig in layout-seed.ts carries the same baseline).
  const paDir = path.join(tmpHome, '.pixel-agents');
  fs.mkdirSync(paDir, { recursive: true });
  const seedConfig = opts.seedConfig ?? {
    vscode: { alwaysShowLabels: true },
    standalone: { alwaysShowLabels: true },
  };
  fs.writeFileSync(path.join(paDir, 'config.json'), JSON.stringify(seedConfig, null, 2));
  if (opts.seedLayout !== undefined) {
    fs.writeFileSync(path.join(paDir, 'layout.json'), JSON.stringify(opts.seedLayout, null, 2));
  }

  // Enable Claude Agent Teams in the test workspace. Real Claude Code reads this
  // env from .claude/settings.local.json on startup; without it, team mode is gated
  // off and the team-related e2e tests can't exercise the
  // feature. Mirrored in the VS Code process env and the macOS terminal profile env
  // below so it survives across all spawn paths.
  const claudeWorkspaceSettingsDir = path.join(workspaceDir, '.claude');
  fs.mkdirSync(claudeWorkspaceSettingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeWorkspaceSettingsDir, 'settings.local.json'),
    JSON.stringify(
      {
        env: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        },
      },
      null,
      2,
    ),
  );

  // Normalize to the canonical path so the project dir hash the extension computes
  // matches the one mock-claude computes from process.cwd().
  //
  // Windows: os.tmpdir() may return an 8.3 short path (e.g. RUNNER~1) while child
  // processes see the long path via %CD%. .native uses GetFinalPathNameByHandleW
  // which resolves 8.3 short names to their full form.
  //
  // macOS: os.tmpdir() returns paths under /var/folders/... but /var is a symlink
  // to /private/var. Zsh-spawned terminals see process.cwd() as /private/var/...
  // while VS Code's workspaceFolders[0].uri.fsPath returns /var/... unchanged.
  // Resolving here ensures both sides agree on /private/var/... and the JSONL
  // project dir resolves to the same path under ~/.claude/projects/.
  const resolvedWorkspaceDir =
    IS_WINDOWS || process.platform === 'darwin'
      ? fs.realpathSync.native(workspaceDir)
      : workspaceDir;

  // Multi-root: create the requested folders as subdirs and open a generated
  // `.code-workspace` listing them, so the extension sees >1 workspace folder.
  // Each folder is realpath-normalized (same rationale as resolvedWorkspaceDir)
  // so the agent terminal's cwd hashes to the same project dir the extension uses.
  const multiRootFolders = opts.workspaceFolders ?? [];
  let openTarget = resolvedWorkspaceDir;
  if (multiRootFolders.length > 1) {
    const folderEntries = multiRootFolders.map((name) => {
      const folderDir = path.join(workspaceDir, name);
      fs.mkdirSync(folderDir, { recursive: true });
      const resolved =
        IS_WINDOWS || process.platform === 'darwin' ? fs.realpathSync.native(folderDir) : folderDir;
      return { path: resolved };
    });
    const workspaceFile = path.join(tmpBase, 'pa.code-workspace');
    fs.writeFileSync(workspaceFile, JSON.stringify({ folders: folderEntries }, null, 2));
    openTarget =
      IS_WINDOWS || process.platform === 'darwin'
        ? fs.realpathSync.native(workspaceFile)
        : workspaceFile;
  }

  // macOS: create a temporary keychain so the OS doesn't show "Keychain Not Found" dialog.
  // The isolated HOME has no keychain, and VS Code/Electron's safeStorage triggers a system prompt.
  if (process.platform === 'darwin') {
    const keychainDir = path.join(tmpHome, 'Library', 'Keychains');
    fs.mkdirSync(keychainDir, { recursive: true });
    const keychainPath = path.join(keychainDir, 'login.keychain-db');
    try {
      const { execSync } = require('child_process');
      execSync(`security create-keychain -p "" "${keychainPath}"`, { stdio: 'ignore' });
      execSync(`security default-keychain -s "${keychainPath}"`, {
        stdio: 'ignore',
        env: { ...process.env, HOME: tmpHome },
      });
    } catch (error) {
      // Keychain creation is non-fatal (the safeStorage dialog may or may not block tests),
      // but we want a breadcrumb when CI starts failing in mysterious ways.
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[e2e] Keychain creation failed for ${keychainPath}: ${message}`);
      try {
        const launchLog = path.join(tmpHome, '.claude-mock', 'launch.log');
        fs.mkdirSync(path.dirname(launchLog), { recursive: true });
        fs.appendFileSync(launchLog, `${new Date().toISOString()} keychain-error: ${message}\n`);
      } catch {
        // launch-log write failure is itself non-fatal
      }
    }
  }

  // Copy mock-claude into an isolated bin dir. The wrapper resolves its sibling
  // scripts (mock-claude-runner.cjs, tail-follow.cjs) relative to its own dir
  // (SCRIPT_DIR / %~dp0), so BOTH must live alongside it here — tail-follow.cjs
  // is what backgrounds the narration tail into each mock terminal tab.
  const mockClaudeBinaryPath = path.join(mockBinDir, IS_WINDOWS ? 'claude.cmd' : 'claude');
  if (IS_WINDOWS) {
    // Windows: copy the .cmd batch file as 'claude.cmd'
    fs.copyFileSync(MOCK_CLAUDE_CMD_PATH, mockClaudeBinaryPath);
    fs.copyFileSync(MOCK_CLAUDE_RUNNER_PATH, path.join(mockBinDir, 'mock-claude-runner.cjs'));
    fs.copyFileSync(TAIL_FOLLOW_PATH, path.join(mockBinDir, 'tail-follow.cjs'));
  } else {
    fs.copyFileSync(MOCK_CLAUDE_PATH, mockClaudeBinaryPath);
    fs.chmodSync(mockClaudeBinaryPath, 0o755);
    fs.copyFileSync(MOCK_CLAUDE_RUNNER_PATH, path.join(mockBinDir, 'mock-claude-runner.cjs'));
    fs.copyFileSync(TAIL_FOLLOW_PATH, path.join(mockBinDir, 'tail-follow.cjs'));
  }

  // VS Code user settings for the isolated profile. Together with
  // arrangeReviewLayout() (e2e/helpers/webview.ts) they produce the run-video
  // layout: Pixel Agents panel docked LEFT at ~2/3 width, terminals opening
  // as editor tabs in the remaining right third, all other chrome hidden.
  //
  // - workbench.panel.defaultLocation "left": the panel (which hosts the
  //   Pixel Agents webview) docks left at full height, so ensurePanelIsLarge()
  //   no-ops instead of driving the flaky "View: Toggle Maximized Panel"
  //   command-palette interaction at the start of every test.
  // - pixel-agents.autoShowPanel: the extension focuses the Pixel Agents view
  //   on activation (onStartupFinished), so openPixelAgentsPanel({ autoShown })
  //   skips the "Pixel Agents: Show Panel" palette interaction at setup.
  // - terminal.integrated.defaultLocation "editor": mock-claude terminals open
  //   as editor tabs beside the office instead of stealing the panel (the
  //   webview has no retainContextWhenHidden, so a panel-hosted terminal.show()
  //   used to dispose it).
  // - The rest strips chrome that eats video space (activity bar, welcome tab,
  //   empty-editor hint, the Chat "Build with Agent" secondary side bar).
  //
  // macOS terminal profile: VS Code's integrated terminal resolves PATH from
  // the login shell, ignoring the process env. Define a custom terminal
  // profile that uses a non-login shell with our mock bin dir in PATH. On
  // Linux the process env propagates directly, so no custom profile is needed.
  const userSettingsDir = path.join(userDataDir, 'User');
  fs.mkdirSync(userSettingsDir, { recursive: true });
  const userSettings: Record<string, unknown> = {
    'workbench.panel.defaultLocation': 'left',
    'pixel-agents.autoShowPanel': true,
    'terminal.integrated.defaultLocation': 'editor',
    'workbench.activityBar.location': 'hidden',
    'workbench.startupEditor': 'none',
    'workbench.editor.empty.hint': 'hidden',
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'chat.commandCenter.enabled': false,
  };
  if (process.platform === 'darwin') {
    userSettings['terminal.integrated.profiles.osx'] = {
      e2e: {
        path: '/bin/zsh',
        args: ['--no-globalrcs'],
        env: {
          PATH: `${mockBinDir}:/usr/local/bin:/usr/bin:/bin`,
          HOME: tmpHome,
          PIXEL_AGENTS_E2E_CLAUDE_BIN: mockClaudeBinaryPath,
          PIXEL_AGENTS_NODE_BIN: process.execPath,
          ZDOTDIR: tmpHome,
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          // inheritEnv is false for this profile, so the diagnostic log
          // path must be set explicitly here or the mock-spawned
          // claude-hook.js (which runs in this terminal) can't write to
          // it. Path matches the `debugLogFile` const below.
          PIXEL_AGENTS_DEBUG_LOG: path.join(tmpHome, '.pixel-agents', 'debug.log'),
          // Narration log paths for the mock-claude wrapper's background tail
          // (see e2e/fixtures/mock-claude). inheritEnv:false means these must
          // be set on the profile too, or internal mock tabs are silently
          // narration-less on macOS — which is where the review videos record.
          // Paths match the process-env block below.
          PIXEL_AGENTS_TEST_NARRATION_LOG: path.join(tmpHome, '.claude-mock', 'test-narration.log'),
          PIXEL_AGENTS_EXTERNAL_NARRATION_LOG: path.join(
            tmpHome,
            '.claude-mock',
            'external-narration.log',
          ),
        },
      },
    };
    userSettings['terminal.integrated.defaultProfile.osx'] = 'e2e';
    userSettings['terminal.integrated.inheritEnv'] = false;
  }
  fs.writeFileSync(
    path.join(userSettingsDir, 'settings.json'),
    JSON.stringify(userSettings, null, 2),
  );
  // Stable, E2E-only path to create the narration terminal without driving
  // the command palette. Pinning the chord in the isolated profile avoids
  // platform/default-keymap differences.
  fs.writeFileSync(
    path.join(userSettingsDir, 'keybindings.json'),
    JSON.stringify(
      [{ key: 'f8', command: 'workbench.action.terminal.newInActiveWorkspace' }],
      null,
      2,
    ),
  );

  const mockLogFile = path.join(tmpHome, '.claude-mock', 'invocations.log');
  const launchLogFile = path.join(tmpHome, '.claude-mock', 'launch.log');

  // --- Video output dir ---
  const safeTitle = testTitle.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const videoDir = IS_WINDOWS ? undefined : path.join(ARTIFACTS_DIR, 'videos', safeTitle);
  if (videoDir) {
    fs.mkdirSync(videoDir, { recursive: true });
  }

  // --- Environment for VS Code process ---
  // applyMockHomeEnv sets HOME on all platforms and additionally pins
  // USERPROFILE (and clears HOMEDRIVE/HOMEPATH) on Windows, where os.homedir()
  // ignores $HOME — see its doc comment for why this is load-bearing.
  // Diagnostic log: server-side broadcasts + hook events go here. Fixture
  // attaches it as `pixel-agents-debug-log` so CI failure analysis can read
  // the exact event timeline. Per-test isolated under tmpHome so parallel
  // workers don't interleave (though e2e uses workers=1 anyway).
  const debugLogFile = path.join(tmpHome, '.pixel-agents', 'debug.log');
  fs.mkdirSync(path.dirname(debugLogFile), { recursive: true });

  const env: Record<string, string> = {
    ...(applyMockHomeEnv(process.env, tmpHome) as Record<string, string>),
    // Prepend mock bin so 'claude' resolves to our mock
    PATH: `${mockBinDir}${PATH_SEP}${process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin'}`,
    PIXEL_AGENTS_E2E_CLAUDE_BIN: mockClaudeBinaryPath,
    PIXEL_AGENTS_E2E_LAUNCH_LOG: launchLogFile,
    PIXEL_AGENTS_NODE_BIN: process.execPath,
    PIXEL_AGENTS_DEBUG_LOG: debugLogFile,
    // Narration log paths, consumed by the mock-claude wrapper to background a
    // headerless tail into its own terminal tab (yellow [test] + magenta
    // [external] lines interleaved with the runner's cyan output). On Linux the
    // process env propagates to the integrated terminal; macOS also needs these
    // on the e2e terminal profile (inheritEnv:false) — see the block above.
    PIXEL_AGENTS_TEST_NARRATION_LOG: path.join(tmpHome, '.claude-mock', 'test-narration.log'),
    PIXEL_AGENTS_EXTERNAL_NARRATION_LOG: path.join(
      tmpHome,
      '.claude-mock',
      'external-narration.log',
    ),
    // Prevent VS Code from trying to talk to real accounts / telemetry
    VSCODE_TELEMETRY_DISABLED: '1',
    // Enable Claude Agent Teams feature (see workspace settings.local.json above)
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  };

  // --- VS Code launch args ---
  const args = [
    // Load our extension in dev mode (this overrides the installed version)
    `--extensionDevelopmentPath=${REPO_ROOT}`,
    // Disable all other extensions so tests are isolated
    '--disable-extensions',
    // Isolated user-data (settings, state, etc.)
    `--user-data-dir=${userDataDir}`,
    // Skip interactive prompts
    '--disable-workspace-trust',
    '--skip-release-notes',
    '--skip-welcome',
    '--no-sandbox',
    // Prevent "Code is currently being updated" errors when the host VS Code
    // is mid-update — the test instance must not participate in update checks.
    '--disable-updates',
    // Disable GPU acceleration: prevents Electron GPU-sandbox stalls in headless
    // CI environments (required on macOS arm64 runners, harmless elsewhere).
    '--disable-gpu',
    // On Linux, use the Ozone headless platform so Electron runs without a
    // display server (equivalent to what --disable-gpu achieves on macOS/Windows).
    ...(process.platform === 'linux' ? ['--ozone-platform=headless'] : []),
    // Open the workspace folder (single dir) or the generated multi-root file.
    openTarget,
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
    if (process.platform === 'darwin') {
      try {
        const keychainPath = path.join(tmpHome, 'Library', 'Keychains', 'login.keychain-db');
        const { execSync } = require('child_process');
        execSync(`security delete-keychain "${keychainPath}"`, { stdio: 'ignore' });
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
        dir: videoDir!,
        size: { width: 1280, height: 800 },
      };
    }

    app = await electron.launch(launchOptions);

    const window = await app.firstWindow();

    // Mark this as the e2e harness BEFORE the Pixel Agents webview iframe loads.
    // addInitScript runs in every frame on attach/navigate (including that
    // iframe, which opens later when the panel is shown), so the webview reads
    // __PIXEL_AGENTS_E2E === true and installs its test-only observability hooks
    // (window.__pixelAgentsTestHooks). In production the flag is absent, so
    // those hooks (and their unbounded logs) never run.
    await window.addInitScript(() => {
      (window as unknown as { __PIXEL_AGENTS_E2E?: boolean }).__PIXEL_AGENTS_E2E = true;
    });

    // The Ozone headless backend ignores --window-size CLI flags, so VS Code
    // opens at a tiny default size on Linux. Resize via the Electron API after
    // the window exists — getAllWindows() is empty before firstWindow() resolves.
    if (process.platform === 'linux') {
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
      videoDir,
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
  await window.waitForSelector('.monaco-workbench', { timeout: 60_000 });
}
