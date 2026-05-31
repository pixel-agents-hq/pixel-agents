import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { expect, type Page } from '@playwright/test';

import { type HookServerConfig, waitForHookServer } from './hooks';

const REPO_ROOT = path.join(__dirname, '../..');
const STANDALONE_CLI = path.resolve(REPO_ROOT, 'dist', 'cli.js');

export interface RecordedServerMessage {
  type: string;
  [key: string]: unknown;
}

export interface StandaloneSession {
  tmpHome: string;
  workspaceDir: string;
  hostUrl: string;
  hookServerConfig: HookServerConfig;
  getHostLogs: () => string;
  cleanup: () => Promise<void>;
  drainMessages: () => Promise<RecordedServerMessage[]>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate a free port'));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForHttpOk(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`GET ${url} returned ${response.status.toString()}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${url}`);
}

/**
 * Spawn our standalone CLI (dist/cli.js). The CLI serves both the SPA and the
 * /ws WebSocket on the same port; tests connect Playwright's chromium to that
 * single origin. Workspace dir is communicated via process.cwd() since our CLI
 * doesn't take a --workspace-dir flag.
 */
function spawnStandaloneHost(args: {
  homeDir: string;
  hostPort: number;
  workspaceDir: string;
}): ChildProcessWithoutNullStreams {
  if (!fs.existsSync(STANDALONE_CLI)) {
    throw new Error(
      `Standalone CLI not built at ${STANDALONE_CLI}. Run 'npm run compile' before standalone e2e tests.`,
    );
  }
  return spawn(
    process.execPath,
    [STANDALONE_CLI, '--port', args.hostPort.toString(), '--host', '127.0.0.1'],
    {
      cwd: args.workspaceDir,
      env: {
        ...process.env,
        HOME: args.homeDir,
        USERPROFILE: args.homeDir,
      },
      stdio: 'pipe',
    },
  );
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    delay(2_000),
  ]);
  if (child.exitCode === null && !child.killed) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      delay(1_000),
    ]);
  }
}

/**
 * Install a WebSocket recorder BEFORE page navigation. Proxies window.WebSocket
 * so every incoming message frame is JSON-parsed and pushed to
 * window.__pixelAgentsMessages, which drainMessages() reads from.
 */
async function installMessageRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const recordedMessages: unknown[] = [];
    const OriginalWebSocket = window.WebSocket;
    const RecordingWebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        socket.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') {
            return;
          }
          try {
            recordedMessages.push(JSON.parse(event.data));
          } catch {
            // Ignore non-JSON frames.
          }
        });
        return socket;
      },
    });
    window.WebSocket = RecordingWebSocket as typeof WebSocket;
    (window as Window & { __pixelAgentsMessages?: unknown[] }).__pixelAgentsMessages =
      recordedMessages;
  });
}

async function drainRecordedMessages(page: Page): Promise<RecordedServerMessage[]> {
  return await page.evaluate(() => {
    const store = (window as Window & { __pixelAgentsMessages?: unknown[] }).__pixelAgentsMessages;
    if (!Array.isArray(store)) {
      return [];
    }
    const drained = store.slice();
    store.length = 0;
    return drained as RecordedServerMessage[];
  });
}

async function openStandalonePage(page: Page, hostUrl: string): Promise<void> {
  await page.goto(`${hostUrl}/`);
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });
}

export async function launchStandalone(page: Page): Promise<StandaloneSession> {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-standalone-e2e-home-'));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-standalone-e2e-workspace-'));
  const hostPort = await getFreePort();
  const hostUrl = `http://127.0.0.1:${hostPort}`;
  const hostProcess = spawnStandaloneHost({
    homeDir: tmpHome,
    hostPort,
    workspaceDir,
  });

  let hostStdout = '';
  let hostStderr = '';
  hostProcess.stdout.on('data', (chunk) => {
    hostStdout += chunk.toString();
  });
  hostProcess.stderr.on('data', (chunk) => {
    hostStderr += chunk.toString();
  });

  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installMessageRecorder(page);
    await waitForHttpOk(`${hostUrl}/api/health`);
    const hookServerConfig = await waitForHookServer(tmpHome);
    await openStandalonePage(page, hostUrl);
    await drainRecordedMessages(page);

    return {
      tmpHome,
      workspaceDir,
      hostUrl,
      hookServerConfig,
      getHostLogs: () =>
        [hostStdout.trim(), hostStderr.trim()].filter((value) => value.length > 0).join('\n'),
      drainMessages: () => drainRecordedMessages(page),
      cleanup: async () => {
        await stopProcess(hostProcess);
        fs.rmSync(tmpHome, { recursive: true, force: true });
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stopProcess(hostProcess);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    throw error;
  }
}
