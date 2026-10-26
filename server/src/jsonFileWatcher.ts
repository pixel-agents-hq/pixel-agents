import * as fs from 'fs';
import * as path from 'path';

import { JSON_FILE_POLL_INTERVAL_MS } from './constants.js';

export interface JsonFileWatcher {
  dispose(): void;
}

/** Each live watcher's "that change was ours" mark, by the path it watches. */
const ownWriteMarks = new Map<string, Set<() => void>>();

/**
 * Write `value` to `filePath` atomically (tmp + rename), creating its directory. Every live
 * watcher of the path takes the change as our own, not an external one. Throws when the
 * write fails, and then marks nothing (a mark with no write behind it would swallow the
 * next real external change).
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
  for (const mark of ownWriteMarks.get(filePath) ?? []) mark();
}

/**
 * Watch a JSON file under ~/.pixel-agents/ for changes made by another process (another
 * VS Code window, the standalone server, a hand edit). Hybrid fs.watch + polling, the
 * same pattern as JSONL watching: fs.watch is unreliable on macOS (kqueue) and Windows,
 * and only attaches once the file exists, so the poll both backs it up and starts it.
 *
 * `onExternalChange` gets the parsed JSON; validating it is the caller's job. A file
 * that does not parse is logged and skipped (a half-finished hand edit), and so is a
 * missing one. Writes made through writeJsonAtomic are not reported.
 */
export function watchJsonFile(
  filePath: string,
  label: string,
  onExternalChange: (value: unknown) => void,
  pollIntervalMs = JSON_FILE_POLL_INTERVAL_MS,
): JsonFileWatcher {
  let lastMtime = 0;
  let fsWatcher: fs.FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  function currentMtime(): number | null {
    try {
      return fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : null;
    } catch {
      return null;
    }
  }

  lastMtime = currentMtime() ?? 0;

  function checkForChange(): void {
    if (disposed) return;
    try {
      const mtime = currentMtime();
      if (mtime === null || mtime <= lastMtime) return;
      lastMtime = mtime;

      const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      console.log(`[Pixel Agents] External ${label} change detected`);
      onExternalChange(value);
    } catch (err) {
      console.error(`[Pixel Agents] Error checking ${label} file:`, err);
    }
  }

  function startFsWatch(): void {
    if (disposed || fsWatcher) return;
    try {
      if (!fs.existsSync(filePath)) return;
      fsWatcher = fs.watch(filePath, () => {
        checkForChange();
      });
      fsWatcher.on('error', (err) => {
        // fs.watch can be unreliable on macOS (kqueue) and may hit inotify limits on Linux
        console.log(`[Pixel Agents] ${label}: fs.watch error: ${err.message}`);
        fsWatcher?.close();
        fsWatcher = null;
      });
    } catch {
      // File may not exist yet — polling will retry
    }
  }

  startFsWatch();

  // Polling backup (also starts fs.watch if the file appears)
  pollTimer = setInterval(() => {
    if (disposed) return;
    if (!fsWatcher) startFsWatch();
    checkForChange();
  }, pollIntervalMs);

  const markOwnWrite = () => {
    const mtime = currentMtime();
    if (mtime !== null) lastMtime = mtime;
  };
  const marks = ownWriteMarks.get(filePath) ?? new Set();
  marks.add(markOwnWrite);
  ownWriteMarks.set(filePath, marks);

  return {
    dispose(): void {
      disposed = true;
      marks.delete(markOwnWrite);
      if (!marks.size) ownWriteMarks.delete(filePath);
      fsWatcher?.close();
      fsWatcher = null;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },
  };
}
