import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import fs from 'fs';
import path from 'path';

import { namespaceE2EPath } from './run-config';

export const VSCODE_CACHE_DIR = path.join(__dirname, '../.vscode-test');
export const VSCODE_PATH_FILE = path.join(VSCODE_CACHE_DIR, 'vscode-executable.txt');
export const ALLURE_RESULTS_DIR = namespaceE2EPath(path.join(__dirname, '../allure-results/e2e'));
const VSCODE_DOWNLOAD_LOCK_DIR = path.join(VSCODE_CACHE_DIR, 'download.lock');
const VSCODE_DOWNLOAD_LOCK_TIMEOUT_MS = 10 * 60_000;
const VSCODE_DOWNLOAD_LOCK_POLL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCachedVSCodePath(): string | null {
  try {
    const vscodePath = fs.readFileSync(VSCODE_PATH_FILE, 'utf8').trim();
    return vscodePath && fs.existsSync(vscodePath) ? vscodePath : null;
  } catch {
    return null;
  }
}

function tryAcquireDownloadLock(): boolean {
  fs.mkdirSync(VSCODE_CACHE_DIR, { recursive: true });

  try {
    fs.mkdirSync(VSCODE_DOWNLOAD_LOCK_DIR);
    fs.writeFileSync(
      path.join(VSCODE_DOWNLOAD_LOCK_DIR, 'owner.json'),
      JSON.stringify(
        {
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

async function withVSCodeDownloadLock<T>(callback: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + VSCODE_DOWNLOAD_LOCK_TIMEOUT_MS;
  let waitingLogged = false;

  while (!tryAcquireDownloadLock()) {
    if (!waitingLogged) {
      console.log('[e2e] Waiting for VS Code cache lock...');
      waitingLogged = true;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for VS Code cache lock at ${VSCODE_DOWNLOAD_LOCK_DIR}`);
    }

    await sleep(VSCODE_DOWNLOAD_LOCK_POLL_MS);
  }

  try {
    return await callback();
  } finally {
    fs.rmSync(VSCODE_DOWNLOAD_LOCK_DIR, { recursive: true, force: true });
  }
}

/**
 * On Windows, VS Code checks for an InnoSetup mutex (`win32MutexName + "-updating"`)
 * at startup. If the host machine's VS Code installer is running (e.g. a pending
 * "Restart to Update"), the mutex is held and ALL VS Code instances — including our
 * test archive — refuse to start with "Code is currently being updated".
 *
 * The check in main.js is:
 *   if (!(isWindows && product.win32MutexName && product.win32VersionedUpdate)) return false;
 *
 * Removing `win32VersionedUpdate` from product.json makes the check short-circuit,
 * so the test instance launches regardless of installer state. This is safe because
 * the test archive is not managed by InnoSetup and never needs update coordination.
 */
function patchProductJsonForWindows(vscodePath: string): void {
  if (process.platform !== 'win32') return;

  // vscodePath points to Code.exe — product.json is in the resources/app dir
  const vscodeDir = path.dirname(vscodePath);
  const candidates = fs
    .readdirSync(vscodeDir)
    .filter((d) => {
      try {
        return fs.statSync(path.join(vscodeDir, d)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((d) => path.join(vscodeDir, d, 'resources', 'app', 'product.json'))
    .filter((p) => fs.existsSync(p));

  for (const productJsonPath of candidates) {
    try {
      const product = JSON.parse(fs.readFileSync(productJsonPath, 'utf8'));
      let patched = false;

      if (product.win32VersionedUpdate) {
        delete product.win32VersionedUpdate;
        patched = true;
      }
      // Also check nested objects (e.g. "tunnelApplicationConfig")
      for (const key of Object.keys(product)) {
        if (typeof product[key] === 'object' && product[key]?.win32VersionedUpdate) {
          delete product[key].win32VersionedUpdate;
          patched = true;
        }
      }

      if (patched) {
        fs.writeFileSync(productJsonPath, JSON.stringify(product, null, '\t') + '\n', 'utf8');
        console.log(`[e2e] Patched product.json to skip InnoSetup mutex check: ${productJsonPath}`);
      }
    } catch (err) {
      console.warn(`[e2e] Failed to patch product.json at ${productJsonPath}:`, err);
    }
  }
}

export default async function globalSetup(): Promise<void> {
  fs.rmSync(ALLURE_RESULTS_DIR, { recursive: true, force: true });

  let vscodePath = readCachedVSCodePath();

  if (!vscodePath) {
    vscodePath = await withVSCodeDownloadLock(async () => {
      const cachedPath = readCachedVSCodePath();
      if (cachedPath) {
        return cachedPath;
      }

      console.log('[e2e] Ensuring VS Code is downloaded...');
      const downloadedPath = await downloadAndUnzipVSCode({
        version: 'stable',
        cachePath: VSCODE_CACHE_DIR,
      });
      console.log(`[e2e] VS Code executable: ${downloadedPath}`);
      patchProductJsonForWindows(downloadedPath);
      fs.writeFileSync(VSCODE_PATH_FILE, downloadedPath, 'utf8');
      return downloadedPath;
    });
  } else {
    console.log(`[e2e] VS Code executable: ${vscodePath}`);
  }

  patchProductJsonForWindows(vscodePath);
  fs.mkdirSync(VSCODE_CACHE_DIR, { recursive: true });
  fs.writeFileSync(VSCODE_PATH_FILE, vscodePath, 'utf8');
}
